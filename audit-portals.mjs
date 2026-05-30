#!/usr/bin/env node

/**
 * audit-portals.mjs — Probe ATS endpoints for websearch-configured companies.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * For each tracked_company with scan_method: websearch, tries Greenhouse,
 * Ashby, and Lever APIs with common slug candidates derived from the name.
 * Reports which companies have an API-backed alternative so they can be
 * switched from websearch (LLM-expensive) to zero-cost structured scans.
 *
 * Does NOT modify portals.yml. Output is a report for human review.
 *
 * Usage:
 *   node audit-portals.mjs
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 8;

function slugCandidates(name) {
  const s = new Set();
  const norm = name.toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\/.*$/, '')
    .trim();
  s.add(norm.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  s.add(norm.replace(/[^a-z0-9]+/g, ''));
  const firstWord = norm.split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
  if (firstWord) s.add(firstWord);
  const stripped = norm.replace(/\s+(ai|labs|inc|io|com)$/i, '').trim();
  if (stripped && stripped !== norm) {
    s.add(stripped.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
    s.add(stripped.replace(/[^a-z0-9]+/g, ''));
  }
  return [...s].filter(Boolean);
}

function countPostings(json) {
  if (Array.isArray(json)) return json.length;
  if (Array.isArray(json.jobs)) return json.jobs.length;
  if (Array.isArray(json.postings)) return json.postings.length;
  if (Array.isArray(json.apiJobs)) return json.apiJobs.length;
  return 0;
}

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    if (!text || text.length < 2) return { ok: false, status: res.status };
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, status: res.status, note: 'non-json' }; }
    const valid = Array.isArray(j) || Array.isArray(j.jobs) || Array.isArray(j.postings) || Array.isArray(j.apiJobs);
    if (!valid) return { ok: false, status: res.status, note: 'bad-shape' };
    return { ok: true, status: res.status, postings: countPostings(j) };
  } catch (e) {
    return { ok: false, err: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function auditCompany(company) {
  const slugs = slugCandidates(company.name);
  const tries = [];
  for (const slug of slugs) {
    tries.push({ ats: 'greenhouse', slug, url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` });
    tries.push({ ats: 'ashby',      slug, url: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true` });
    tries.push({ ats: 'lever',      slug, url: `https://api.lever.co/v0/postings/${slug}` });
  }
  const hits = [];
  for (const t of tries) {
    const r = await probe(t.url);
    if (r.ok) hits.push({ ...t, ...r });
  }
  return hits;
}

function renderField(company, best) {
  if (!best) return '';
  if (best.ats === 'greenhouse') {
    return `careers_url: https://job-boards.greenhouse.io/${best.slug}\n    api: ${best.url}`;
  }
  if (best.ats === 'ashby') {
    return `careers_url: https://jobs.ashbyhq.com/${best.slug}`;
  }
  if (best.ats === 'lever') {
    return `careers_url: https://jobs.lever.co/${best.slug}`;
  }
  return '';
}

async function main() {
  const doc = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
  const websearchCos = doc.tracked_companies.filter(c =>
    c.enabled !== false && c.scan_method === 'websearch'
  );

  console.error(`Auditing ${websearchCos.length} websearch-configured companies...\n`);

  const queue = [...websearchCos];
  const results = [];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const co = queue.shift();
      const hits = await auditCompany(co);
      const best = hits.length ? hits.sort((a, b) => b.postings - a.postings)[0] : null;
      results.push({ company: co.name, best, all: hits });
      const status = best
        ? `✅ ${best.ats.padEnd(10)} ${String(best.postings).padStart(4)} postings  slug=${best.slug}`
        : `❌ no API match`;
      console.error(`  ${co.name.padEnd(32)} ${status}`);
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => a.company.localeCompare(b.company));
  const hits = results.filter(r => r.best);
  const misses = results.filter(r => !r.best);

  console.log('\n# API-audit report\n');
  console.log(`- Total websearch-configured companies: ${websearchCos.length}`);
  console.log(`- Found API-backed alternative: ${hits.length}`);
  console.log(`- No API match (keep on websearch or disable): ${misses.length}\n`);

  const byAts = {};
  for (const h of hits) byAts[h.best.ats] = (byAts[h.best.ats] || 0) + 1;
  console.log('## Distribution of API hits');
  for (const [ats, n] of Object.entries(byAts)) console.log(`- ${ats}: ${n}`);

  console.log('\n## Switch candidates (high confidence — API returns postings)\n');
  console.log('| Company | ATS | Postings | Slug | Suggested careers_url |');
  console.log('|---------|-----|----------|------|------------------------|');
  for (const r of hits.filter(r => r.best.postings > 0)) {
    const url = r.best.ats === 'greenhouse'
      ? `https://job-boards.greenhouse.io/${r.best.slug}`
      : r.best.ats === 'ashby'
        ? `https://jobs.ashbyhq.com/${r.best.slug}`
        : `https://jobs.lever.co/${r.best.slug}`;
    console.log(`| ${r.company} | ${r.best.ats} | ${r.best.postings} | \`${r.best.slug}\` | ${url} |`);
  }

  const zeroHits = hits.filter(r => r.best.postings === 0);
  if (zeroHits.length) {
    console.log('\n## API matched but 0 postings (could be empty board OR wrong slug — verify)\n');
    console.log('| Company | ATS | Slug |');
    console.log('|---------|-----|------|');
    for (const r of zeroHits) console.log(`| ${r.company} | ${r.best.ats} | \`${r.best.slug}\` |`);
  }

  console.log('\n## No API match (keep websearch or disable)\n');
  for (const r of misses) console.log(`- ${r.company}`);
}

main().catch(e => { console.error(e); process.exit(1); });
