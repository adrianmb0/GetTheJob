#!/usr/bin/env node

/**
 * fetch-jd.mjs — Zero-token JD fetcher
 *
 * Given a job posting URL, returns the full job description text by
 * hitting the underlying ATS JSON API directly (Greenhouse / Ashby / Lever).
 * No JavaScript rendering, no LLM tokens — just structured JSON.
 *
 * Falls back to nothing for unknown portals (caller decides what to do).
 *
 * Usage:
 *   node batch/fetch-jd.mjs <url>                     # print JSON to stdout
 *   node batch/fetch-jd.mjs <url> --out file.txt      # write plain text body
 *   node batch/fetch-jd.mjs --batch urls.txt --dir out/   # batch mode
 *
 * Output JSON shape:
 *   {
 *     ok: true,
 *     platform: "greenhouse" | "ashby" | "lever",
 *     title, company, location, body, comp, url
 *   }
 *   or
 *   { ok: false, error, url, platform }
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const FETCH_TIMEOUT_MS = 10_000;

// ── URL → API mapping ──────────────────────────────────────────────

function detectPlatform(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname;
  const path = url.pathname;
  const params = url.searchParams;

  // Greenhouse — direct boards
  // boards.greenhouse.io/{board}/jobs/{id}
  // job-boards.greenhouse.io/{board}/jobs/{id}
  // job-boards.eu.greenhouse.io/{board}/jobs/{id}
  let m = path.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (m && /greenhouse\.io$/.test(host)) {
    return {
      platform: 'greenhouse',
      board: m[1],
      jobId: m[2],
      apiUrl: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`,
    };
  }

  // Greenhouse via custom company domain using ?gh_jid=
  // e.g. https://stripe.com/jobs/search?gh_jid=7655023
  //      https://careers.datadoghq.com/detail/123/?gh_jid=123
  //      https://www.brex.com/careers/123?gh_jid=123
  const ghJid = params.get('gh_jid');
  if (ghJid) {
    const overrides = {
      'stripe.com': 'stripe',
      'careers.datadoghq.com': 'datadog',
      'www.pinterestcareers.com': 'pinterest',
      'pinterestcareers.com': 'pinterest',
      'www.brex.com': 'brex',
      'sumup.com': 'sumup',
      'www.sumup.com': 'sumup',
      'www.asana.com': 'asana',
      'asana.com': 'asana',
      'n26.com': 'n26',
      'www.n26.com': 'n26',
      'getyourguide.careers': 'getyourguide',
      'helsing.ai': 'helsing',
      'www.helsing.ai': 'helsing',
      'traderepublic.com': 'traderepublic',
      'www.traderepublic.com': 'traderepublic',
      'databricks.com': 'databricks',
      'www.databricks.com': 'databricks',
    };
    let board = overrides[host];
    if (!board) {
      // Fallback heuristic: take the registrable domain's first label.
      // careers.datadoghq.com → datadoghq ; www.brex.com → brex
      const parts = host.split('.');
      board = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    }
    return {
      platform: 'greenhouse',
      board,
      jobId: ghJid,
      apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${ghJid}`,
    };
  }

  // Ashby — jobs.ashbyhq.com/{org}/{job_uuid}
  m = path.match(/^\/([^/]+)\/([0-9a-f-]{30,})/);
  if (m && host === 'jobs.ashbyhq.com') {
    return {
      platform: 'ashby',
      org: m[1],
      jobId: m[2],
      // Ashby has no documented single-job endpoint; fetch the full list
      // and pick the matching jobId. Cheap (one HTTP call per company).
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${m[1]}?includeCompensation=true`,
    };
  }

  // Lever — jobs.lever.co/{org}/{id}
  m = path.match(/^\/([^/]+)\/([0-9a-f-]+)/);
  if (m && host === 'jobs.lever.co') {
    return {
      platform: 'lever',
      org: m[1],
      jobId: m[2],
      apiUrl: `https://api.lever.co/v0/postings/${m[1]}/${m[2]}`,
    };
  }

  return null;
}

// ── HTML → plain text (lightweight, no deps) ───────────────────────

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&[a-zA-Z0-9#]+;/g, ' ');
}

function htmlToText(html) {
  if (!html) return '';
  // Decode entities FIRST so tags hidden as &lt;div&gt; become <div> and can be stripped.
  // Run twice — Greenhouse double-encodes some content.
  let s = decodeEntities(decodeEntities(html));
  return s
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[ \t]+/gm, '')
    .trim();
}

// ── Fetch with timeout ─────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'get-the-job fetch-jd/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-platform parsers ───────────────────────────────────────────

function parseGreenhouseJob(json) {
  if (!json || !json.title) throw new Error('greenhouse: empty response');
  const body = htmlToText(json.content || '');
  return {
    title: json.title,
    company: json.company_name || '',
    location: json.location?.name || '',
    body,
    comp: json.pay_input_ranges
      ? json.pay_input_ranges.map(r => `${r.min_cents/100}-${r.max_cents/100} ${r.currency_type}`).join('; ')
      : '',
  };
}

function parseAshbyJob(json, jobId) {
  const jobs = json?.jobs || [];
  const job = jobs.find(j => (j.jobUrl || '').includes(jobId) || j.id === jobId);
  if (!job) throw new Error(`ashby: job ${jobId} not found in board listing`);
  const body = htmlToText(job.descriptionHtml || job.descriptionPlain || '');
  let comp = '';
  if (job.compensation?.compensationTierSummary) {
    comp = job.compensation.compensationTierSummary;
  } else if (job.compensationTierSummary) {
    comp = job.compensationTierSummary;
  }
  return {
    title: job.title || '',
    company: '',
    location: job.location || '',
    body,
    comp,
  };
}

function parseLeverJob(json) {
  if (!json) throw new Error('lever: empty response');
  // descriptionPlain is the headline; lists[] hold the actual sections.
  const sections = [json.descriptionPlain || ''];
  for (const list of json.lists || []) {
    sections.push(`\n${list.text || ''}\n${htmlToText(list.content || '')}`);
  }
  if (json.additionalPlain) sections.push(`\n${json.additionalPlain}`);
  return {
    title: json.text || '',
    company: '',
    location: json.categories?.location || '',
    body: sections.join('\n').trim(),
    comp: json.salaryRange
      ? `${json.salaryRange.min}-${json.salaryRange.max} ${json.salaryRange.currency}`
      : '',
  };
}

// ── Main ───────────────────────────────────────────────────────────

export async function fetchJd(rawUrl) {
  const det = detectPlatform(rawUrl);
  if (!det) {
    return { ok: false, error: 'unknown-platform', url: rawUrl, platform: null };
  }

  try {
    const json = await fetchJson(det.apiUrl);
    let parsed;
    if (det.platform === 'greenhouse') parsed = parseGreenhouseJob(json);
    else if (det.platform === 'ashby') parsed = parseAshbyJob(json, det.jobId);
    else if (det.platform === 'lever') parsed = parseLeverJob(json);

    if (!parsed.body || parsed.body.length < 100) {
      return { ok: false, error: 'empty-body', url: rawUrl, platform: det.platform, partial: parsed };
    }

    return { ok: true, platform: det.platform, url: rawUrl, ...parsed };
  } catch (e) {
    return { ok: false, error: String(e.message || e), url: rawUrl, platform: det.platform };
  }
}

// ── CLI ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { url: null, out: null, batch: null, dir: null, format: 'json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--batch') args.batch = argv[++i];
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--text') args.format = 'text';
    else if (!a.startsWith('--') && !args.url) args.url = a;
  }
  return args;
}

function formatTextOutput(r) {
  if (!r.ok) return `# FETCH FAILED\nURL: ${r.url}\nPlatform: ${r.platform}\nError: ${r.error}\n`;
  const parts = [
    `# ${r.title}`,
    r.company ? `Company: ${r.company}` : '',
    r.location ? `Location: ${r.location}` : '',
    r.comp ? `Comp: ${r.comp}` : '',
    `URL: ${r.url}`,
    `Platform: ${r.platform}`,
    '',
    r.body,
  ].filter(Boolean);
  return parts.join('\n');
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));

  if (args.batch) {
    if (!args.dir) {
      console.error('--batch requires --dir');
      process.exit(2);
    }
    if (!existsSync(args.dir)) mkdirSync(args.dir, { recursive: true });
    const urls = readFileSync(args.batch, 'utf-8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const results = [];
    for (const url of urls) {
      const r = await fetchJd(url);
      results.push(r);
      const slug = url.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      const ext = args.format === 'text' ? 'txt' : 'json';
      const outPath = `${args.dir}/${slug}.${ext}`;
      writeFileSync(outPath, args.format === 'text' ? formatTextOutput(r) : JSON.stringify(r, null, 2));
      console.error(`${r.ok ? '✓' : '✗'} ${url} → ${outPath}`);
    }
    const ok = results.filter(r => r.ok).length;
    console.error(`\n${ok}/${urls.length} succeeded`);
    return;
  }

  if (!args.url) {
    console.error('Usage: node batch/fetch-jd.mjs <url> [--out file] [--text]');
    console.error('       node batch/fetch-jd.mjs --batch urls.txt --dir out/ [--text]');
    process.exit(2);
  }

  const r = await fetchJd(args.url);
  const out = args.format === 'text' ? formatTextOutput(r) : JSON.stringify(r, null, 2);

  if (args.out) {
    if (dirname(args.out) !== '.') mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, out);
    console.error(`${r.ok ? '✓' : '✗'} ${args.url} → ${args.out}`);
  } else {
    process.stdout.write(out + '\n');
  }
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch(e => { console.error(e); process.exit(2); });
}
