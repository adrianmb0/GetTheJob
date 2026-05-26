# GetTheJob

AI-powered job search toolkit — scan job boards, score postings against your profile, track applications, and apply with tailored materials. All from one place.

Built on the [career-ops](https://github.com/santifer/career-ops) engine.

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/GetTheJob.git
cd GetTheJob
npm install
npm start
```

Open [http://localhost:3737](http://localhost:3737).

## First-time setup

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

## What it does

| Feature | Command |
|---------|---------|
| **Scan** job boards for new postings | `npm run scan` |
| **Dashboard** to view and filter results | `npm start` → localhost:3737 |
| **Triage** score postings against your profile | Via Claude Code / AI assistant |
| **Track** applications end-to-end | Dashboard tracker view |
| **Generate** tailored CVs and cover letters | Via AI assistant |

## Dashboard features

- Sortable columns (score, company, date, location)
- Multi-select filter dropdowns (verdict, score range, company, location)
- Triage-to-tracker workflow
- Application status overview

## Project structure

```
GetTheJob/
  server.mjs              Dashboard server
  scan.mjs                Portal scanner (Greenhouse, Ashby, Lever APIs)
  check-liveness.mjs      Verify postings are still active
  generate-pdf.mjs        HTML-to-PDF CV generator (Playwright)
  modes/                  Evaluation and workflow instructions
  templates/              CV templates, example configs
  config/                 Profile config (your copy is gitignored)
  data/                   Your application data (gitignored)
  reports/                Evaluation reports (gitignored)
```

## Your data stays private

Personal files (`cv.md`, `config/profile.yml`, `portals.yml`, everything in `data/` and `reports/`) are gitignored. Only the engine and templates are committed. Your job search data never leaves your machine.

## Requirements

- Node.js 18+
- Playwright (`npx playwright install chromium` for PDF generation)

## License

MIT
