# Mode: skip — Mark a Posting Skipped

Removes a triaged posting from the apply queue without applying. Used when the user decides a posting isn't worth pursuing despite its triage score.

## Inputs

User provides one of:
- A URL: `/get-the-job skip https://example.com/jobs/123`
- A row number from a previous queue display: `/get-the-job skip 5`
- A company + role substring: `/get-the-job skip Sierra Voice` (matches the only Sierra Voice posting in queue)

## Workflow

### Step 1 — Resolve the input to a URL

- If input is a URL: use as-is
- If input is a row number: cross-reference the most recent `find-jobs` queue display in this session and pick the URL at that position. If no queue is in context, ask user to paste the URL or run `/get-the-job find-jobs` first.
- If input is a substring: grep `data/triage-scores.tsv` for matching company + role. If exactly one match, use it. If multiple matches, list them and ask user to disambiguate.

### Step 2 — Locate the row

Search `data/triage-scores.tsv` for the URL. Also check `data/applications.md` (in case the URL has a full report already).

### Step 3 — Remove from queue

**If found in `data/triage-scores.tsv`:**
- Drop the row entirely. Use awk + atomic rename:
  ```bash
  awk -F'\t' -v url="$URL" 'NR==1 || $1 != url' data/triage-scores.tsv > data/triage-scores.tsv.tmp \
    && mv data/triage-scores.tsv.tmp data/triage-scores.tsv
  ```

**If found in `data/applications.md` with status=Evaluated:**
- Update the row: change status from `Evaluated` to `Discarded`. This is a normal canonical state (see `templates/states.yml`) — it preserves the report for reference but removes from apply queue.
- Edit applications.md directly (this is a status update, not an addition — allowed per CLAUDE.md pipeline rules).
- Append `; SKIP via /get-the-job skip on YYYY-MM-DD` to the notes column.

**If found in BOTH:** Drop from triage-scores.tsv AND mark Discarded in applications.md.

**If found in NEITHER:** Tell the user — "URL not in apply queue. Nothing to skip."

### Step 4 — Optional reason

If the user provided a reason (e.g. `/get-the-job skip <url> reason="comp too low"`), append it to the notes/log so future patterns analysis can see why postings get rejected. If not, no reason is required — the user doesn't owe the system an explanation.

### Step 5 — Confirm

Brief one-liner output:

```
Skipped: {company} — {role}
Removed from triage-scores.tsv ({reason if given})
```

Don't lecture about the decision. Don't suggest reconsidering. The user has decided; respect it.

## What NOT to do

- Don't generate any reports or evaluations
- Don't email anyone
- Don't add to `data/applications.md` if the posting wasn't already there (skip should be lightweight — just remove from queue)
- Don't ask for a reason if the user didn't provide one

## Reverse: undoing a skip

If the user says "actually I want to apply to {url} after all" — they can just run `/get-the-job apply <url>` directly. Apply mode will trigger a fresh evaluation since the posting isn't in `applications.md` (or upgrades from `Discarded` → `Applied`).

## Bulk skip

If the user provides multiple URLs in one invocation (`/get-the-job skip url1 url2 url3`), process each in sequence and emit one summary line per URL.
