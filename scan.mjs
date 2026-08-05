#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, Lever and Consider APIs directly, reads
 * climate.jobs listing pages, applies title filters from portals.yml,
 * deduplicates against existing history, and appends new offers to
 * pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

// Consider-hosted boards (consider.com) are talent networks: ONE endpoint covering
// every company a fund has invested in, rather than one board per employer. The host
// does not name the board, so it has to be mapped — the same approach
// batch/fetch-jd.mjs takes for Greenhouse behind custom domains. One line per fund.
const CONSIDER_BOARDS = {
  'jobs.a16z.com': 'andreessen-horowitz',
  'portfoliojobs.a16z.com': 'andreessen-horowitz',
};

// climate.jobs is a curated climate-sector aggregator — one board covering many
// employers, like a Consider network, but with no JSON API to call: its robots.txt
// disallows /api/. What it does serve is plain server-rendered HTML, so the adapter
// reads the same listing pages a browser gets. As with Consider, the filters live in
// the careers_url query string: filter the board in the browser and paste the URL.
const CLIMATE_JOBS_HOST = 'climate.jobs';
// 24 cards a page, and a filtered board is a few dozen postings. Well past that, so
// hitting the cap means the URL is too broad rather than the board being big.
const CLIMATE_JOBS_MAX_PAGES = 10;

// A Consider board has no per-company slug to scan; what narrows it is the filter set,
// and the board keeps that in its own URL query string. So careers_url IS the
// configuration: filter the board in the browser, paste the URL, and the scan reads
// exactly what you saw. Two values need the fixups the board's own UI applies before
// querying — job types are slugs, and stage labels drop their parenthetical.
function considerQuery(url) {
  const params = new URL(url).searchParams;
  const slug = (s) => s.toLowerCase().trim().replace(/\s+/g, '-');
  const stage = (s) => s.replace(/\s*\(.*\)\s*$/, '').trim();
  const query = {};

  const posted = params.get('postedSince');
  if (posted) query.postedSince = posted;

  const lists = {
    jobTypes: slug,
    stages: stage,
    markets: (s) => s,
    locations: (s) => s,
    departments: (s) => s,
    skills: (s) => s,
  };
  for (const [key, map] of Object.entries(lists)) {
    const values = params.getAll(key).filter(Boolean).map(map);
    if (values.length) query[key] = values;
  }

  for (const flag of ['hybridOrRemoteOnly', 'remoteOnly']) {
    if (params.get(flag) === 'true') query[flag] = true;
  }

  return query;
}

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Consider talent networks (jobs.a16z.com) — one endpoint, many employers.
  const considerHost = Object.keys(CONSIDER_BOARDS).find(h => url.includes(h));
  if (considerHost) {
    return {
      type: 'consider',
      url: `https://${considerHost}/api-boards/search-jobs`,
      body: {
        // Far above what a filtered board returns (a week of Product Manager postings
        // across the a16z portfolio is single digits). The caller warns rather than
        // truncating silently if a wider URL ever exceeds it.
        meta: { size: 200 },
        board: { id: CONSIDER_BOARDS[considerHost], isParent: true },
        query: considerQuery(url),
        grouped: false,
      },
      // The board ignores salary in the query — it filters client-side, so we do too.
      salaryMin: Number(new URL(url).searchParams.get('salaryMin')) || 0,
    };
  }

  // climate.jobs — HTML listing board, one entry covering every employer on it.
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* not a URL */ }
  if (host === CLIMATE_JOBS_HOST) {
    return { type: 'climatejobs', url, source: 'climatejobs-html' };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

// Consider is the one board where the employer comes from the PAYLOAD rather than
// portals.yml — a fund's talent network lists hundreds of companies under a single
// entry, so `companyName` here is only the fallback label.
function parseConsider(json, companyName, api) {
  const jobs = json.jobs || [];
  const floor = api?.salaryMin || 0;
  return jobs
    // Only a PUBLISHED minimum can fail the floor. Plenty of good postings name no
    // range at all, and dropping those would hide them for a reason we never checked.
    .filter(j => !(floor && j.salary?.minValue && j.salary.minValue < floor))
    .map(j => ({
      title: j.title || '',
      // The board links straight to the employer's own ATS posting, which is why
      // batch/fetch-jd.mjs can already read these without a new platform handler.
      url: j.url || j.applyUrl || '',
      company: j.companyName || companyName,
      location: (j.locations || []).join('; ') || (j.remote ? 'Remote' : ''),
    }));
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  ashby: parseAshby,
  lever: parseLever,
  consider: parseConsider,
};

// ── climate.jobs (HTML board) ───────────────────────────────────────

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// As with Consider, the employer comes from the card rather than portals.yml — one
// entry covers the whole board — so `boardName` is only the fallback label.
function parseClimateJobsPage(html, boardName) {
  return html.split('<article class="job-card').slice(1).map(card => {
    const href = card.match(/<a href="(\/company\/[^"]+)"/)?.[1];
    if (!href) return null;

    // The location chip is dropped entirely on locked cards, and the comment marking
    // it stays behind — so without this check the match would run on to the next
    // chip and label the job "Remote" as if that were a place.
    const chip = card.match(/<!-- Location[\s\S]*?-->([\s\S]*?)<\/span>/)?.[1] || '';
    const hasChip = chip.trimStart().startsWith('<span');
    let location = hasChip ? stripTags(chip) : '';
    // The board writes locations as prose ("Work remotely from UK") that no country
    // keyword in location_filter would match. The chip's flag carries the ISO code,
    // so append it — that gives location_filter a stable token to work with.
    const country = hasChip ? chip.match(/\btitle="([A-Z]{2})"/)?.[1] : null;
    if (country && !location.includes(country)) {
      location = location ? `${location} (${country})` : country;
    }

    const page = `https://${CLIMATE_JOBS_HOST}${href}`;
    return {
      title: stripTags(card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] || ''),
      company: stripTags(card.match(/font-medium truncate">([\s\S]*?)<\/p>/)?.[1] || '') || boardName,
      location,
      url: page,
      // A climate.jobs posting page carries a summary and says as much — it points at
      // the employer's own listing for the real description. So the link worth queueing
      // is the outbound one, and it costs a second fetch to read. Deferred to a hook so
      // the scan pays it once per title match, not once per card on the board.
      resolve: () => resolveClimateJobsUrl(page),
    };
  }).filter(Boolean);
}

async function resolveClimateJobsUrl(pageUrl) {
  try {
    const html = await fetchText(pageUrl);
    const outbound = html.match(/href="(https?:\/\/[^"]*\bref=climatejobs[^"]*)"/)?.[1];
    return outbound ? outbound.replace(/&amp;/g, '&') : null;
  } catch {
    return null;   // caller falls back to the climate.jobs page
  }
}

async function fetchClimateJobs(api, boardName) {
  const jobs = [];
  const firstCardSeen = new Set();
  let page = 1;

  for (; page <= CLIMATE_JOBS_MAX_PAGES; page++) {
    const pageUrl = new URL(api.url);
    pageUrl.searchParams.set('page', String(page));
    const found = parseClimateJobsPage(await fetchText(pageUrl.href), boardName);
    if (found.length === 0) break;
    // Past the last page the board re-serves page 1 rather than 404ing, so stop on a
    // repeat instead of collecting the same cards until the cap.
    if (firstCardSeen.has(found[0].url)) break;
    firstCardSeen.add(found[0].url);
    jobs.push(...found);
  }

  const warning = page > CLIMATE_JOBS_MAX_PAGES
    ? `read ${jobs.length} postings over ${CLIMATE_JOBS_MAX_PAGES} pages and stopped — ` +
      `narrow the URL in portals.yml (e.g. add ?posted=7d)`
    : null;

  return { jobs, warning };
}

// ── Fetch with timeout ──────────────────────────────────────────────

// `body` turns this into a POST — Consider's search endpoint takes its filters in a
// JSON body where the other three take a plain GET.
async function fetchJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const options = { signal: controller.signal };
    if (body) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// For boards that publish no API — the page a browser would get.
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'get-the-job scan/1.0', Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────

function buildLocationFilter(locationFilter) {
  const positive = (locationFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (locationFilter?.negative || []).map(k => k.toLowerCase());

  return (location) => {
    if (!location) return true; // unknown location passes through
    const lower = location.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

// The same posting reaches us under several spellings. scan-history.tsv already holds
// all three Greenhouse hosts (boards, job-boards, job-boards.eu), and a portfolio board
// hands back the employer's ATS link with its own decorations: a `?gh_jid=` query, a
// percent-encoded Ashby slug ("Flock%20Safety"). Compared as raw strings those read as
// different jobs, so a role already in the Inbox would be queued a second time.
// Only membership tests are canonicalised — what gets WRITTEN stays the URL as
// received, because that is the link the user has to be able to open.
function canonicalUrl(u) {
  try {
    const parsed = new URL(String(u).trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = decodeURIComponent(parsed.pathname).toLowerCase().replace(/\/+$/, '');
    return `${host === 'boards.greenhouse.io' ? 'job-boards.greenhouse.io' : host}${path}`;
  } catch {
    return String(u).trim().toLowerCase();   // local:jds/... and other non-URLs
  }
}

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(canonicalUrl(url));
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(canonicalUrl(match[1]));
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(canonicalUrl(match[0]));
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Append under the pending section. New files (written by the setup wizard) use
  // English headings; files from older installs use the original Spanish ones, so
  // accept either rather than bolting a second "## Pendientes" onto an English file.
  const marker = ['## Pending', '## Pendientes'].find(m => text.includes(m)) || '## Pending';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No pending section — append at the end, before the processed one
    const procIdx = ['## Processed', '## Procesadas']
      .map(m => text.indexOf(m)).find(i => i !== -1) ?? -1;
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of the existing pending content (next ## or end of file)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalLocFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];
  const warnings = [];

  const tasks = targets.map(company => async () => {
    const { type, url, body } = company._api;
    try {
      let jobs;
      if (type === 'climatejobs') {
        const read = await fetchClimateJobs(company._api, company.name);
        jobs = read.jobs;
        if (read.warning) warnings.push(`${company.name}: ${read.warning}`);
      } else {
        const json = await fetchJson(url, body);
        jobs = PARSERS[type](json, company.name, company._api);

        // A search board answers with a page, not the whole board. Say so rather than
        // reporting a truncated read as if it were the full picture.
        if (json.total > (json.jobs?.length ?? 0)) {
          warnings.push(`${company.name}: read ${json.jobs.length} of ${json.total} postings — ` +
            `narrow the URL in portals.yml (e.g. postedSince=P7D)`);
        }
      }
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalLocFiltered++;
          continue;
        }
        // Aggregators list a job the employer also posts on its own ATS. Swap in that
        // link before the dedup check, so a posting already in the Inbox under its ATS
        // URL is recognised rather than queued a second time under the aggregator's.
        const { resolve, ...offer } = job;
        if (resolve) offer.url = (await resolve()) || offer.url;
        const canonical = canonicalUrl(offer.url);
        if (seenUrls.has(canonical)) {
          totalDupes++;
          continue;
        }
        const key = `${offer.company.toLowerCase()}::${offer.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(canonical);
        seenCompanyRoles.add(key);
        newOffers.push({ ...offer, source: company._api.source || `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by location:  ${totalLocFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /get-the-job pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
