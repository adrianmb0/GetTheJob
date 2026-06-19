# GetTheJob

Your entire job search in one place — from first scan to signed offer.

GetTheJob scans job boards, scores every posting against your profile, generates tailored resumes and application materials, and tracks everything in a single dashboard. No more spreadsheets, no more losing track of where you stand.

## How it works

1. **Scan** — Automatically discovers open roles from company career pages and job boards
2. **Score & Triage** — Each posting is scored against your profile so you focus on the best fits
3. **Apply Packs** — Generates a custom resume, cover letter, and application answers for every role you pursue — ready to paste into any application form
4. **Track** — One dashboard from application to offer, with status updates, follow-up cadences, and interview prep

## Getting started — from zero

Never touched a terminal? Almost none needed — you'll **install one program, paste one command, and click an app.** About 5 minutes. Follow the steps in order.

> **What you need:** a Mac (the one-click app is macOS — Windows/Linux works too, see the terminal path in each step). The dashboard, scanning, and tracking are **free**. The **AI features** (scoring jobs, tailored resumes) run on [Claude Code](https://claude.com/claude-code) with a Claude Pro or Max plan — you can add that later; everything else works without it.

### 1. Install Node.js (one time per computer)

GetTheJob runs on Node.js. Go to **[nodejs.org](https://nodejs.org)**, download the **LTS** version, open the downloaded file, and click through the installer. That's it. (This also installs `npm`, which the app needs.)

### 2. Get GetTheJob

Open **Terminal** (press ⌘-Space, type `Terminal`, hit Enter) and paste this, then Enter:

```bash
git clone https://github.com/adrianmb0/GetTheJob.git
```

- If macOS pops up *"install the command line developer tools,"* click **Install**, wait for it, then run the command again.
- You now have a **`GetTheJob`** folder (in your home folder). *(Getting it this way — rather than a ZIP — is what lets the app launch on the first click without a macOS security warning.)*

### 3. Open it

Open the `GetTheJob` folder in Finder and **double-click `GetTheJob.app`** (drag it to your Dock for one-click access later).

- The app opens a **setup page in your browser** that walks you through the rest. On the first run it installs everything (~1 minute — you'll see a Terminal doing it) and then **takes you straight to setup automatically.** You don't have to click anything again.
- If you don't have Node.js yet, that page shows a **Download Node.js** button — install it, then click `GetTheJob.app` again.

**Prefer the terminal? (any OS):**

```bash
cd GetTheJob
npm install
npm start
```

Then open **[http://localhost:3737](http://localhost:3737)**.

### 4. Set up your profile (~3 min)

The dashboard opens into a **guided wizard** — enter your name and target roles, pick a few companies to track, and paste or upload your resume. It writes all the config for you; no files to edit.

### 5. Find jobs — free

On the last step, click **Run Your First Scan** (or run `npm run scan`). It checks the job boards of the companies you picked and fills your **Inbox** with open roles. No AI, no cost.

### 6. Score them against your profile — needs Claude Code

Scanning finds jobs; the **AI scoring** runs in [Claude Code](https://claude.com/claude-code) (Pro or Max plan):

1. Open the `GetTheJob` folder in Claude Code — in a terminal: `cd GetTheJob && claude`, or open the folder with the Claude Code VS Code / JetBrains extension.
2. Run **`/get-the-job triage`** — it reads each posting, scores it 1–5 against your profile, and fills your Inbox with verdicts (Apply High / Apply / Skip).
3. Refresh the dashboard Inbox to see them ranked.

### 7. Apply

Send the strong leads to your **Pipeline**, then run **`/get-the-job apply`** to generate a tailored resume, cover letter, and application answers for that role — ready to paste into any form. See [Scoring & applying](#scoring--applying-the-claude-code-step) for the full loop.

### Opening it again later

Just **click `GetTheJob.app`** again (or run `npm start` in the folder) and open [http://localhost:3737](http://localhost:3737). After the one-time setup above, it starts instantly. On **Windows / Linux** there's no `.app` — use `npm start`.

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

1. Enter your profile basics (name, email, location, LinkedIn)
2. Pick your industry/field and target roles
3. Choose companies to track — select from a per-industry list, or paste any Greenhouse / Ashby / Lever careers URL
4. Upload or paste your resume
5. Add your story — headline, strengths, and a proof point (optional, powers cover letters)
6. Run your first scan

The wizard writes `config/profile.yml`, `portals.yml`, and `cv.md` for you. When it finishes, it points macOS users to `GetTheJob.app` for one-click launches (see [Opening it again later](#opening-it-again-later)).

Power users can still set up manually via config files (see [First-time setup](#first-time-setup-manual)).

## Scoring & applying (the Claude Code step)

The dashboard finds, filters, and tracks jobs for free on plain Node. The **AI work — scoring postings and writing tailored resumes and cover letters — runs in [Claude Code](https://claude.com/claude-code)** (Pro or Max plan). After setup, the loop is:

1. **Open the project in Claude Code.** In a terminal: `cd GetTheJob && claude` — or open the `GetTheJob` folder with the Claude Code VS Code / JetBrains extension.
2. **Find jobs:** `/get-the-job scan` (or click *Run scan* in the dashboard, or `npm run scan`). New postings land in `data/pipeline.md`.
3. **Score them:** `/get-the-job triage` — reads each new posting, scores it 1–5 against your profile, and writes the results to your **Inbox** (`data/triage-scores.tsv`).
4. **Review:** refresh the dashboard Inbox at [localhost:3737](http://localhost:3737) to see scored leads with verdict chips (Apply High / Apply / Skip). Filter and sort to find the best fits.
5. **Shortlist → apply:** send a lead to your Pipeline, then `/get-the-job apply` generates a tailored resume, cover letter, and application answers for that role.

> Tip: `/get-the-job morning-batch` runs steps 2–3 (scan + triage) in a single command.

> **Uploaded your resume as a PDF?** The AI reads `cv.md`, not the PDF. In your first Claude Code session, ask it to *“convert cv.pdf into cv.md”* before scoring.

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
