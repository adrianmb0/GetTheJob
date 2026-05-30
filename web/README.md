# get-the-job web dashboard (v1, read-only)

Tiny Node.js HTTP server. Zero npm deps (built-ins only).

Run:
    node web/server.mjs

Then open http://localhost:3737

Routes:
- `/` — applications tracker (filter: `?status=Evaluated`)
- `/triage` — triage scores sorted by score desc
- `/report?file=reports/<name>.md` — single report rendered

Not built yet: write/mutation endpoints, auth, search, sortable columns, charts, follow-up view, scan trigger.
