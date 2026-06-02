#!/bin/bash
# Sends a markdown-formatted email of high-priority apply queue.
# Reads BOTH data/triage-scores.tsv (lightweight scored, no full report yet)
# AND data/applications.md (status=Evaluated, full report exists).
# Dedups by URL, ranks by score, labels NEW vs CARRIED OVER.
#
# Invoked from the morning-batch mode (or run manually for testing).

set -euo pipefail

# Resolve the repo root from this script's own location (scripts/ → repo root).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECIPIENT="adrian.mb97@gmail.com"
THRESHOLD="4.0"
APPLICATIONS="$REPO/data/applications.md"
TRIAGE="$REPO/data/triage-scores.tsv"
LOG_DIR="$REPO/scripts/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/apply-queue-$(date +%Y-%m-%d-%H%M).log"
TODAY=$(date +%Y-%m-%d)

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

if [[ ! -f "$APPLICATIONS" ]]; then
  log "ERROR: $APPLICATIONS not found"
  exit 1
fi

# ---------------------------------------------------------------------------
# Source 1: applications.md — postings with full reports already (Evaluated)
# Output cols: score \t company \t role \t url \t report_path \t source \t age_label
# ---------------------------------------------------------------------------
APPS_QUEUE=$(awk -F'|' -v threshold="$THRESHOLD" '
  /^\| [0-9]+ \|/ {
    score=$6; gsub(/[ \/5]/, "", score);
    status=$7; gsub(/^ +| +$/, "", status);
    if (status == "Evaluated" && score+0 >= threshold+0) {
      for (i=2;i<=9;i++) gsub(/^ +| +$/, "", $i);
      r = $9;
      sub(/.*\(reports\//, "reports/", r);
      sub(/\).*/, "", r);
      printf "%s\t%s\t%s\tPENDING_URL\t%s\tapps\n", score, $4, $5, r
    }
  }' "$APPLICATIONS")

# Resolve URLs from report headers
APPS_QUEUE_RESOLVED=""
if [[ -n "$APPS_QUEUE" ]]; then
  while IFS=$'\t' read -r score company role _url report source; do
    url=""
    if [[ -f "$REPO/$report" ]]; then
      url=$(grep -m1 "^\*\*URL:" "$REPO/$report" 2>/dev/null | sed 's/^\*\*URL:\*\* *//' | tr -d '\r' || echo "")
    fi
    APPS_QUEUE_RESOLVED+="${score}	${company}	${role}	${url}	${report}	${source}	carried"$'\n'
  done <<< "$APPS_QUEUE"
fi

APPS_COUNT=$(echo -n "$APPS_QUEUE_RESOLVED" | grep -c '^' || true)
log "applications.md: $APPS_COUNT postings (Evaluated, score >= $THRESHOLD)"

# ---------------------------------------------------------------------------
# Source 2: triage-scores.tsv — lightweight scored (no full report yet)
# Format: url \t first_seen \t score \t verdict \t company \t role \t location \t one_line_note
# Output cols: score \t company \t role \t url \t report_path \t source \t age_label
# ---------------------------------------------------------------------------
TRIAGE_QUEUE=""
if [[ -f "$TRIAGE" ]]; then
  TRIAGE_QUEUE=$(awk -F'\t' -v threshold="$THRESHOLD" -v today="$TODAY" '
    NR > 1 {
      url=$1; first_seen=$2; score=$3; verdict=$4; company=$5; role=$6; location=$7; note=$8;
      if (score+0 >= threshold+0 && (verdict == "APPLY HIGH" || verdict == "APPLY" || verdict == "APPLY (reach)")) {
        age_label = (first_seen == today) ? "new" : "carried";
        # Use note as report_path placeholder for triage rows (they have no report yet)
        printf "%s\t%s\t%s\t%s\t(triage: %s)\ttriage\t%s\n", score, company, role, url, note, age_label
      }
    }' "$TRIAGE")
fi

TRIAGE_COUNT=$(echo -n "$TRIAGE_QUEUE" | grep -c '^' || true)
log "triage-scores.tsv: $TRIAGE_COUNT postings (verdict APPLY*, score >= $THRESHOLD)"

# ---------------------------------------------------------------------------
# Merge + dedup by URL (prefer apps row over triage row)
# ---------------------------------------------------------------------------
MERGED=$(printf "%s%s" "$APPS_QUEUE_RESOLVED" "$TRIAGE_QUEUE" | awk -F'\t' '
  $4 != "" && !seen[$4]++ { print }
  $4 == "" { print }   # apps rows where URL extraction failed; keep them, dedup not possible
' | sort -t$'\t' -k1 -nr)

TOTAL=$(echo -n "$MERGED" | grep -c '^' || true)
NEW_COUNT=$(echo -n "$MERGED" | awk -F'\t' '$7=="new"' | grep -c '^' || true)
CARRIED_COUNT=$((TOTAL - NEW_COUNT))
log "Merged: $TOTAL total ($NEW_COUNT new today, $CARRIED_COUNT carried over)"

# ---------------------------------------------------------------------------
# Build markdown body
# ---------------------------------------------------------------------------
BODY_FILE=$(mktemp -t apply-queue-body)
trap 'rm -f "$BODY_FILE"' EXIT

if [[ "$TOTAL" -eq 0 ]]; then
  SUBJECT="Career-ops apply queue — nothing this week"
  cat > "$BODY_FILE" <<EOF
No postings >=${THRESHOLD}/5 ready to apply.

This means either:
  - No new postings >=${THRESHOLD} since last triage, AND
  - All previously-queued postings have been applied to or skipped.

If you weren't expecting that, run /get-the-job morning-batch to scan + triage fresh listings.
EOF
else
  TOP=$(echo "$MERGED" | head -1)
  TOP_SCORE=$(echo "$TOP" | cut -f1)
  TOP_COMPANY=$(echo "$TOP" | cut -f2)
  TOP_ROLE=$(echo "$TOP" | cut -f3)

  SUBJECT="Career-ops apply queue - $TOTAL postings ($NEW_COUNT new, $CARRIED_COUNT carried)"

  {
    echo "Top priority: $TOP_COMPANY - $TOP_ROLE ($TOP_SCORE/5)"
    echo
    echo "Apply window: 8-10 AM. Open Claude Code, run /get-the-job apply <url> for each."
    echo

    if [[ "$NEW_COUNT" -gt 0 ]]; then
      echo "## NEW THIS RUN ($NEW_COUNT postings)"
      echo
      echo "| Score | Company | Role | URL | Source |"
      echo "|-------|---------|------|-----|--------|"
      echo "$MERGED" | awk -F'\t' '$7=="new"' | while IFS=$'\t' read -r score company role url report source _age; do
        echo "| $score | $company | $role | $url | $source |"
      done
      echo
    fi

    if [[ "$CARRIED_COUNT" -gt 0 ]]; then
      echo "## CARRIED OVER ($CARRIED_COUNT postings)"
      echo
      echo "These were on a previous email. Apply, /get-the-job skip <url>, or let them auto-purge after 14 days."
      echo
      echo "| Score | Company | Role | URL | Source |"
      echo "|-------|---------|------|-----|--------|"
      echo "$MERGED" | awk -F'\t' '$7=="carried"' | while IFS=$'\t' read -r score company role url report source _age; do
        echo "| $score | $company | $role | $url | $source |"
      done
      echo
    fi

    echo "---"
    echo
    echo "Source legend:"
    echo "  apps    = full A-G report exists in reports/ (deeply evaluated)"
    echo "  triage  = lightweight score only; full report generated on /get-the-job apply"
    echo
    echo "Per posting:"
    echo "  1. Open URL in browser"
    echo "  2. /get-the-job apply <url>     (generates full report if needed, drafts answers)"
    echo "  3. Review, submit"
    echo "  4. Auto-marked Applied; URL drops from queue"
    echo
    echo "To remove without applying: /get-the-job skip <url>"
  } > "$BODY_FILE"
fi

log "Subject: $SUBJECT"

# Send via Mail.app as plain text. Read body as UTF-8 to avoid mojibake.
osascript <<APPLESCRIPT
set bodyText to (read POSIX file "$BODY_FILE" as «class utf8»)
tell application "Mail"
  set newMsg to make new outgoing message with properties {subject:"$SUBJECT", content:bodyText, visible:false}
  tell newMsg
    make new to recipient at end of to recipients with properties {address:"$RECIPIENT"}
    send
  end tell
end tell
APPLESCRIPT

log "Email sent to $RECIPIENT"
