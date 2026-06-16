# GetTheJob

Your entire job search in one place — from first scan to signed offer.

GetTheJob scans job boards, scores every posting against your profile, generates tailored resumes and application materials, and tracks everything in a single dashboard. No more spreadsheets, no more losing track of where you stand.

## How it works

1. **Scan** — Automatically discovers open roles from company career pages and job boards
2. **Score & Triage** — Each posting is scored against your profile so you focus on the best fits
3. **Apply Packs** — Generates a custom resume, cover letter, and application answers for every role you pursue — ready to paste into any application form
4. **Track** — One dashboard from application to offer, with status updates, follow-up cadences, and interview prep

## Quick start

> **Prerequisite:** the AI features run on [Claude Code](https://claude.com/claude-code) with a Claude Pro or Max plan. The dashboard and scanner work without it. See [Requirements](#requirements).

```bash
git clone https://github.com/adrianmb0/GetTheJob.git
cd GetTheJob
npm install
npm start
```

Open [http://localhost:3737](http://localhost:3737) — the guided setup wizard walks you through everything.

## What you get

| Feature | How |
|---------|-----|
| **Scan** job boards for new postings | `npm run scan` — hits Greenhouse, Ashby, Lever APIs and more |
| **Dashboard** to view, filter, and sort results | `npm start` → localhost:3737 |
| **Triage** — score postings against your profile | Automated scoring with AI evaluation |
| **Apply Packs** — tailored resume + cover letter + answers | Generated per role, ready to copy-paste |
| **Track** applications end-to-end | Tracker view with status, follow-ups, and pipeline |
| **Generate** polished PDF resumes | `npm run pdf` — Playwright-based PDF generation |

## Dashboard

- **Tracker** — all your applications with sortable columns, status filters, and one-click actions
- **Triage** — scored postings with verdict chips (Apply High, Apply, Skip), multi-select filters by company, location, score range
- **Apply Packs** — view the generated resume, cover letter, and application answers for each role
- **Reports** — detailed evaluation reports explaining why each role is a fit (or not)

## Guided onboarding

New users see an interactive setup wizard — no manual config file editing required:

1. Preview the dashboard with sample data
2. Enter your profile basics (name, location, target roles)
3. Select your industry and the kinds of roles you're after
4. Upload or paste your resume
5. You're ready — run your first scan

Power users can still set up manually via config files (see [First-time setup](#first-time-setup-manual)).

## First-time setup (manual)

1. Copy the example configs:
   ```bash
   cp config/profile.example.yml config/profile.yml
   cp templates/portals.example.yml portals.yml
   cp modes/_profile.template.md modes/_profile.md
   ```
2. Edit `config/profile.yml` with your name, target roles, and comp targets
3. Create `cv.md` with your resume in Markdown
4. Edit `portals.yml` to add companies you want to scan
5. Run `npm start` and open the dashboard

## Project structure

```
GetTheJob/
  server.mjs              Dashboard server (tracker, triage, onboarding)
  scan.mjs                Portal scanner (Greenhouse, Ashby, Lever APIs)
  check-liveness.mjs      Verify postings are still active
  generate-pdf.mjs        HTML-to-PDF CV generator (Playwright)
  modes/                  Evaluation and workflow instructions
  templates/              CV templates, example configs
  examples/               Sample data, demo files
  config/                 Profile config (your copy is gitignored)
  data/                   Your application data (gitignored)
  reports/                Evaluation reports (gitignored)
```

## Your data stays private

Personal files (`cv.md`, `config/profile.yml`, `portals.yml`, everything in `data/` and `reports/`) are gitignored. Only the engine and templates are committed. Your job search data never leaves your machine.

## Requirements

GetTheJob runs on **[Claude Code](https://claude.com/claude-code)** — that's the engine behind triage scoring, apply packs, and evaluation reports. To use those features you'll need:

- **[Claude Code](https://claude.com/claude-code)** with a **Claude Pro or Max subscription**
- **Node.js 18+**
- **Playwright** (`npx playwright install chromium`) — for PDF resume generation

**What works with no AI cost:** the dashboard (`npm start`) and the job scanner (`npm run scan`) run on plain Node — you can browse, scan, filter, and track entirely for free. AI is only spent when you ask for a triage score, an apply pack, or a full evaluation, so you control the spend.

> **Coming later:** a free tier that runs on other agent runtimes (Gemini CLI's free tier, OpenCode with your own model). Today the smoothest experience is Claude Code + a Pro/Max plan, and that's what this release targets.

## License

MIT
