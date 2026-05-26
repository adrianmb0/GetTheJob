# Mode: triage — Lightweight Per-URL Scoring

Per-URL scoring mode. Called by `morning-batch` to score new pipeline URLs cheaply. Does NOT produce a full A–G report; that happens later in `apply` mode if the user actually applies.

**Cost goal:** ~$0.05 per URL. Skip everything that isn't strictly needed to decide "is this worth applying to or not."

## Inputs

- A single JD URL (passed in as `{{url}}`) plus, if known, company + role + location from `pipeline.md`
- `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_shared.md` (load once, cache for the batch run)
- `data/triage-scores.tsv` (existing scores, to dedup)
- `data/scan-history.tsv` (for first_seen freshness)

## Workflow

### Step 1 — Skip if already scored

If the URL is already in `data/triage-scores.tsv`, skip. Triage runs are incremental — only score URLs that don't have a row yet.

### Step 2 — Fetch the JD

**Primary path (zero-token, structured):** run `node batch/fetch-jd.mjs <url> --text` via Bash. This hits the underlying Greenhouse/Ashby/Lever JSON API directly and returns the full JD body as plain text. Covers ~85% of URLs in the pipeline (Greenhouse, Ashby, Lever, plus custom domains using `?gh_jid=` like Stripe/Datadog/Pinterest/Brex/Databricks). Reliable and JS-free.

**Fallback:** if `fetch-jd.mjs` exits non-zero (`unknown-platform` or HTTP error), THEN use **WebFetch**. If WebFetch also fails or returns a generic careers landing page (not the actual JD), mark verdict `SUSPICIOUS` with note `"JD fetch failed — verify manually"` and write the row anyway. Don't retry; move on.

Read the FULL JD content. This step is the whole point of triage — deep JD reading is what differentiates this from a title-only filter. Title-only triage produces garbage scores.

### Step 3 — Apply scoring rubric

Use the same A–F scoring logic from `_shared.md` (Match con CV, North Star alignment, Comp, Cultural signals, Red flags). Calculate a global 1.0–5.0 score.

**Hard exclusions** (auto-score 1.0, verdict `SKIP`):
- Microsoft (current employer) — see `modes/_profile.md`
- LinkedIn or GitHub (Microsoft-owned)
- Crypto / web3 / blockchain
- Pre-Senior PM level (APM, PM I, junior, associate, intern, etc.)
- **Staff PM, Group PM, Director+, VP, CPO** — these require 8-10+ years and/or managing PMs; out of range
- Pre-seed / seed-stage company
- Comp known to be below $200K USD floor
- **Required experience > 7 years** (Adrian has ~5; 8+, 10+, etc. are out of range)
- **People-manager roles** (managing PMs as direct reports — see `modes/_profile.md` for the distinction between "leading cross-functional teams" which is fine vs "managing PMs" which isn't)
- **Non-US/non-Remote locations** — Europe, Asia, Oceania are out of scope (see `location_filter` in `portals.yml`)

**Soft penalties** (don't auto-skip, but reflect in score):
- Hard requirement of skill Adrian doesn't have (e.g. specific industry vertical)
- Onsite-only in city Adrian isn't in
- Posting age >14 days (use `scan-history.tsv` `first_seen` for the URL — drop entirely if known)

### Step 4 — Compose verdict

Assign one of:

| Verdict | When |
|---|---|
| `APPLY HIGH` | Score ≥4.5 — top priority |
| `APPLY` | Score 4.2–4.49 — apply confidently |
| `APPLY (reach)` | Score 4.0–4.19 — apply if time/interest, has gap |
| `SKIP` | Score <4.0 OR hard exclusion hit |
| `SUSPICIOUS` | Posting legitimacy concerns (closed, ghost-job signals, generic page) |

### Step 5 — Write the row

Append a single tab-separated line to `data/triage-scores.tsv`. Create the file with this header if it doesn't exist:

```
url	first_seen	score	verdict	company	role	location	one_line_note
```

Row format:
- `url`: the JD URL exactly as given
- `first_seen`: today's date in YYYY-MM-DD (used for 14-day auto-purge)
- `score`: numeric, format `X.X` (e.g. `4.3`)
- `verdict`: one of the 5 verdicts above
- `company`: short company name
- `role`: exact role title from JD
- `location`: short location string (e.g. `Remote US`, `SF hybrid`, `NYC`, `London`, `Seattle`). Use `Remote` for fully remote with no country restriction. Leave empty if unknown.
- `one_line_note`: ≤120 chars, format: `top fit + top gap + comp flag`. Examples:
  - `"Founding PM at agent-platform unicorn; 0-to-1 + AI-native fit; $200-300K; remote-first"`
  - `"Strong Technical AI PM match but requires 8+ yrs (Adrian ~5); comp $260-340K; SF hybrid"`
  - `"SKIP — onsite-only in NYC, no remote, comp not disclosed"`

**RULE — append only.** Never rewrite the file. Multiple parallel triage calls may be writing simultaneously; appending is safe.

### Step 6 — Done

No PDF. No full report. No applications.md row. No keyword extraction. No STAR stories. Just the TSV row.

The full A–G report only gets generated in `apply` mode, IF the user actually decides to apply.

---

## What NOT to do in triage

- Do NOT generate a markdown report file in `reports/`
- Do NOT add a row to `data/applications.md`
- Do NOT generate STAR stories or interview prep
- Do NOT generate a tailored CV / cover letter / PDF
- Do NOT do company deep-research (that's `deep` mode)
- Do NOT do LinkedIn outreach research (that's `contacto` mode)

If the user later runs `/career-ops apply <url>` on a triage-scored URL, the apply mode will trigger the full evaluation on demand.

## Output to user when called directly (not from morning-batch)

If a user invokes `/career-ops triage <url>` manually, also print the row contents to chat after writing, so they can see what got recorded:

```
Triaged: {company} — {role} ({location})
Score: {X.X}/5 — {verdict}
{one_line_note}
Written to data/triage-scores.tsv
```

When called from `morning-batch`, suppress this output (the batch runner aggregates and reports in summary form).
