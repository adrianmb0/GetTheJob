# Mode: morning-batch — Manual Tue/Fri Morning Pipeline

The user runs this manually on their chosen mornings (e.g. Tue + Fri). Orchestrates scan + triage + (optional) email so by the time they're ready to apply, the queue is fresh and ranked.

**Architecture choice:** Everything happens inside this active Claude Code session. No bash scripts. No `claude -p` headless. No launchd cron. The user invokes it manually; they can walk away while it runs and come back when it's done.

## Workflow

### Step 1 — Confirm intent

Before doing anything, briefly state what you're about to do and the expected duration. Example:

```
Running morning-batch:
  1. Scan portals for new postings (~30 sec, free)
  2. Triage new URLs (deep JD read + score, ~$0.05 each)
  3. Auto-purge triage entries >14 days old
  4. Auto-purge tracker entries >14 days old (Evaluated/Discarded/SKIP only)
  5. Cross-state purge + liveness sweep (drop already-applied / closed postings)
  6. Send email digest (optional, default: yes)

This typically takes 5-15 min depending on how many new postings landed since last run.
Starting now.
```

Don't ask for confirmation — the user invoked the mode, that's the confirmation. Just announce and start.

### Step 2 — Run the scan

Run `node scan.mjs` via Bash. Capture and report the count of new URLs added to `data/pipeline.md`. If scan errors, surface the error and stop — do not proceed to triage on stale data.

### Step 3 — Identify URLs to triage

Compute the diff: URLs in `data/pipeline.md` that are NOT already in `data/triage-scores.tsv`. These are the ones to triage this run.

Also: filter OUT any URLs whose `first_seen` in `data/scan-history.tsv` is older than 14 days. Don't waste tokens triaging stale postings.

Report the count: "Triaging {N} new URLs."

### Step 4 — Triage in parallel

For each URL in the to-triage list, invoke the `triage` mode logic (load `modes/triage.md`).

**Parallelization strategy:**
- For ≤5 URLs: do them sequentially in this session. Fast enough.
- For 6–30 URLs: launch parallel subagents via the **Agent tool** (one Agent call per URL, all in a single message for true concurrency). Each subagent gets `_shared.md` + `triage.md` injected and the URL as input.
- For 31+ URLs: chunk into batches of 20 and run sequentially-of-batches, parallel-within-batches, to avoid hitting any concurrency limits.

Each subagent writes its row directly to `data/triage-scores.tsv` (append-only, safe for concurrent writes).

While triage is running, the user is free to walk away. Stream a short progress update every 5 URLs or at the end of each batch:

```
Triage progress: 12/27 done
```

### Step 5 — Auto-purge stale triage entries

After triage completes, drop rows from `data/triage-scores.tsv` whose **posting date** (from `data/scan-history.tsv`) is more than 14 days ago. The posting date is when the scanner first saw the URL on the company's job board — this is the real freshness signal, not when the triage row was written.

```bash
# Build a set of URLs whose scan-history first_seen is older than 14 days
awk -F'\t' -v cutoff="$(date -v-14d +%Y-%m-%d 2>/dev/null || date -d '14 days ago' +%Y-%m-%d)" '
  NR > 1 && $2 < cutoff { print $1 }
' data/scan-history.tsv | sort -u > /tmp/stale-posted-urls.txt

# Drop matching rows from triage-scores.tsv (keep rows with no scan-history match — unknown age)
awk -F'\t' 'NR==FNR { stale[$0]=1; next } FNR==1 || !($1 in stale)' \
  /tmp/stale-posted-urls.txt data/triage-scores.tsv > data/triage-scores.tsv.tmp \
  && mv data/triage-scores.tsv.tmp data/triage-scores.tsv
```

Report how many rows were purged.

### Step 5.1 — Auto-purge stale tracker entries

After the triage purge, sweep `data/applications.md` for stale rows. Run:

```bash
node scripts/purge-stale-tracker.mjs
```

Rules (encoded in the script):
- Purges only rows whose status is in `{Evaluated, Discarded, SKIP}` AND whose date is older than 14 days
- Preserves `Applied`, `Responded`, `Interview`, `Offer`, `Rejected` regardless of age (active pipeline + history for `patterns` analysis)
- Backs up to `data/applications.md.bak` before writing
- `--dry-run` to preview, `--days N` to override the threshold

Report the row count purged.

### Step 5.5 — Liveness sweep + cross-state purge

Before building the apply queue, drop anything that's no longer applyable:

**A. Cross-state dedup (cheap, do first — no network):**
For every URL in `data/triage-scores.tsv`, check if it also appears in `data/applications.md` with a status in `[Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP]`. If so, drop the row from `triage-scores.tsv` — the application is already underway or closed.

```bash
# Extract URLs from applications.md that are NOT status=Evaluated
# (Evaluated rows should stay in queue; everything else should be purged from triage)
```

Use awk/grep to build a list of "already-acted-on" URLs from applications.md, then filter triage-scores.tsv:

```bash
# Pull URLs from applications.md rows whose status is not Evaluated
grep -oE 'https?://[^ |)]+' data/applications.md | sort -u > /tmp/in-applications.txt
# Drop matching rows from triage-scores.tsv
awk -F'\t' 'NR==FNR{seen[$0]=1; next} FNR==1 || !($1 in seen)' \
  /tmp/in-applications.txt data/triage-scores.tsv > data/triage-scores.tsv.tmp \
  && mv data/triage-scores.tsv.tmp data/triage-scores.tsv
```

(More precise: parse applications.md table and exclude only rows where status=Evaluated; those are still candidates. Everything else — Applied through SKIP — gets purged from triage.)

**B. Liveness sweep (network — only on the survivors):**
Take the candidate URLs that will appear in the apply queue (triage-scores.tsv with verdict APPLY*/score≥4.0 + applications.md with status=Evaluated/score≥4.0) and write them to a temp file:

```bash
# Build candidate URL list, then run liveness check
node check-liveness.mjs --file /tmp/queue-candidates.txt
```

For each URL marked `expired`:
- If the URL is in `data/triage-scores.tsv` → drop the row (atomic awk + rename)
- If the URL is in `data/applications.md` with status=Evaluated → update status to `Discarded` and append `; auto-purged: posting closed YYYY-MM-DD` to notes
- Append the URL to `batch/expired-urls.txt` for record-keeping

For URLs marked `uncertain`: keep them in the queue but tag them `⚠️ unverified` in the Step 7 display so the user can spot-check.

Report: `Liveness sweep: {N} active, {M} removed (closed/expired), {K} uncertain.`

**Why both A and B:** A is free and catches the "already applied / already skipped" case (the user's main concern). B catches "company took the posting down" — costs Playwright launches but only on the small candidate set, not the whole triage table.

### Step 6 — Build the apply queue

Merge candidates for the user's apply queue:

1. Rows from `data/triage-scores.tsv` with `verdict` in `[APPLY HIGH, APPLY, APPLY (reach)]` AND score ≥ 4.0 — these are triaged but no full report yet
2. Rows from `data/applications.md` with status == "Evaluated" AND score ≥ 4.0 — these have a full report already

**Dedup:** if the same URL appears in both files, prefer the `applications.md` row (full report exists, more authoritative). Match by URL exactly.

Sort by score descending.

Tag each row:
- 🆕 **NEW THIS RUN** — first_seen in triage-scores.tsv equals today's date
- 📅 **CARRIED OVER** — first_seen earlier than today (still in queue from a previous run, user hasn't applied or skipped)

### Step 7 — Display the queue in chat

Show the merged queue right in the Claude Code session:

```
## Apply queue — {N total} postings ({X new}, {Y carried over})

🆕 NEW THIS RUN
| Score | Company | Role | URL | Notes |
|-------|---------|------|-----|-------|
| 4.7   | ...     | ...  | ... | ...   |
...

📅 CARRIED OVER (act on these or /get-the-job skip <url>)
| Score | Company | Role | URL | Notes |
|-------|---------|------|-----|-------|
...
```

If carried-over count > 0, gently remind the user:
> {Y} postings carried from a previous run. If you don't want to apply, run `/get-the-job skip <url>` to remove from queue. They'll auto-purge after 14 days regardless.

### Step 8 — Final summary

```
Morning-batch complete.

Scanned:      {N} new URLs added to pipeline.md
Triaged:      {N} URLs scored ({M} APPLY-grade ≥4.0)
Auto-purged:  {N} stale triage entries (>14 days)
Tracker:      {N} stale tracker rows purged (>14 days, Evaluated/Discarded/SKIP only)
Cross-state:  {N} dropped (already Applied/Rejected/Discarded/SKIP in applications.md)
Liveness:     {N} active, {M} removed (closed), {K} uncertain
Apply queue:  {N total} postings ready ({X new today, Y carried over})

Cost:         ~${X.XX}  (subscription credits)
Duration:     {X}m {Y}s

Ready to apply. Top picks (highest scores first):
  1. /get-the-job apply {top URL}     ({company} — {role}, {score})
  2. /get-the-job apply {next}        (...)
  ...

To remove from queue without applying:
  /get-the-job skip {url}             (or by row number from the table above)
```

---

## What NOT to do in morning-batch

- Do NOT run full evaluations (those happen on-demand in `apply` mode)
- Do NOT generate PDFs or cover letters
- Do NOT update `data/applications.md` for triage results (only `apply` writes there)
- Do NOT skip the auto-purge step — it keeps triage-scores.tsv from growing forever

## Failure modes

- **Scan fails:** Stop and report. Don't proceed to triage on stale pipeline.
- **WebFetch returns generic page for some URLs:** Those get verdict `SUSPICIOUS` and a note; they don't block other URLs.
- **User Ctrl-C mid-run:** Triage is append-only and per-URL; partial progress is preserved. Re-running morning-batch will skip already-triaged URLs.

## When to run

- **Tue 7:00 AM PT** — catches Mon AM posting surge
- **Fri 7:00 AM PT** — catches Tue/Wed/Thu postings
- **Ad hoc** — anytime user wants a fresh queue check

The user runs this manually. There is no cron, scheduler, or background process.
