# GetTheJob

Job application dashboard — track, triage, and manage your job search from one place.

## Quick start

```bash
git clone https://github.com/your-username/GetTheJob.git
cd GetTheJob
npm start
```

Open [http://localhost:3737](http://localhost:3737).

## Usage

Point GetTheJob at a directory containing your job search data:

```bash
# Default: reads from the current directory
npm start

# Point at a career-ops project
DATA_DIR=~/Documents/GitHub/career-ops npm start

# Custom port
PORT=8080 npm start
```

## Data format

GetTheJob reads standard TSV and Markdown files:

- `data/applications.md` — application tracker (Markdown table)
- `data/triage-scores.tsv` — triage scores (tab-separated)
- `reports/*.md` — evaluation reports

Compatible with [career-ops](https://github.com/santifer/career-ops) out of the box.

## Features

- Sortable columns (score, company, date, location)
- Filterable dropdowns (verdict, score range, company, location) with multi-select
- Triage-to-tracker workflow (shortlist directly from the triage view)
- Zero dependencies — single Node.js file, no npm install needed

## Requirements

Node.js 18+

## License

MIT
