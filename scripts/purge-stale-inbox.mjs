#!/usr/bin/env node
// Purge stale entries from the inbox files:
//   - data/triage-scores.tsv  (the dashboard Inbox)
//   - data/pipeline.md        (pending URLs — only unchecked `- [ ]` lines)
//
// An entry is purged iff its URL's first_seen in data/scan-history.tsv is
// older than the max age. Entries with no scan-history match (unknown age)
// are kept. data/scan-history.tsv itself is NEVER touched — scan.mjs uses it
// as the permanent dedup ledger, so purged URLs are never re-added.
//
// Max age resolution order:
//   1. --days N flag
//   2. preferences.max_job_age_days in config/profile.yml
//   3. default 7
// A value of 0 means "never purge" — the script exits without changes.
//
// Writes a .bak backup per mutated file. Atomic: temp file + rename.
//
// Flags:
//   --dry-run   Print what would be purged; don't write
//   --days N    Override age threshold

import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_HISTORY = join(ROOT, 'data', 'scan-history.tsv');
const TRIAGE = join(ROOT, 'data', 'triage-scores.tsv');
const PIPELINE = join(ROOT, 'data', 'pipeline.md');
const PROFILE = join(ROOT, 'config', 'profile.yml');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function configuredMaxAge() {
  try {
    if (!existsSync(PROFILE)) return null;
    const prof = yaml.load(readFileSync(PROFILE, 'utf8')) || {};
    const v = prof.preferences && prof.preferences.max_job_age_days;
    if (v === 0) return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const daysFlagIdx = args.indexOf('--days');
let MAX_AGE_DAYS;
if (daysFlagIdx >= 0) {
  MAX_AGE_DAYS = parseInt(args[daysFlagIdx + 1], 10);
  if (!Number.isFinite(MAX_AGE_DAYS) || MAX_AGE_DAYS < 0) {
    console.error('Invalid --days value');
    process.exit(2);
  }
} else {
  const cfg = configuredMaxAge();
  MAX_AGE_DAYS = cfg === null ? 7 : cfg;
}

if (MAX_AGE_DAYS === 0) {
  console.log('Inbox purge disabled (max_job_age_days: 0). Nothing to do.');
  process.exit(0);
}

if (!existsSync(SCAN_HISTORY)) {
  console.log(`No ${SCAN_HISTORY} — nothing to purge against.`);
  process.exit(0);
}

const today = new Date();
today.setHours(0, 0, 0, 0);
const cutoff = new Date(today.getTime() - MAX_AGE_DAYS * 86400_000);
const cutoffStr = cutoff.toISOString().slice(0, 10);

// url -> first_seen from scan-history.tsv; stale = first_seen < cutoff
const staleUrls = new Set();
{
  const rows = readFileSync(SCAN_HISTORY, 'utf8').split('\n');
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split('\t');
    const url = (cols[0] || '').trim();
    const firstSeen = (cols[1] || '').trim();
    if (url && /^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && firstSeen < cutoffStr) {
      staleUrls.add(url);
    }
  }
}

console.log(`Cutoff: ${cutoffStr} (${MAX_AGE_DAYS} days ago)`);
console.log(`Stale URLs in scan-history: ${staleUrls.size}`);
console.log('');

function writeAtomic(path, content) {
  copyFileSync(path, path + '.bak');
  const tmp = path + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// --- triage-scores.tsv ---
let triagePurged = 0;
if (existsSync(TRIAGE)) {
  const lines = readFileSync(TRIAGE, 'utf8').split('\n');
  const out = [];
  const purged = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 || !line.trim()) { out.push(line); continue; }
    const url = line.split('\t')[0].trim();
    if (staleUrls.has(url)) { purged.push(line); continue; }
    out.push(line);
  }
  triagePurged = purged.length;
  console.log(`triage-scores.tsv: purging ${triagePurged} rows, keeping ${out.filter(l => l.trim()).length - 1}`);
  for (const p of purged) {
    const c = p.split('\t');
    console.log(`  ${(c[1] || '?').padEnd(10)} ${(c[4] || '?').padEnd(20)} ${(c[5] || '?').slice(0, 50)}`);
  }
  if (!DRY_RUN && triagePurged > 0) writeAtomic(TRIAGE, out.join('\n'));
} else {
  console.log('triage-scores.tsv: not found, skipping');
}
console.log('');

// --- pipeline.md (pending `- [ ]` lines only) ---
let pipelinePurged = 0;
if (existsSync(PIPELINE)) {
  const lines = readFileSync(PIPELINE, 'utf8').split('\n');
  const out = [];
  const purged = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[ \]\s*(\S+)/);
    if (m && staleUrls.has(m[1].trim())) { purged.push(line); continue; }
    out.push(line);
  }
  pipelinePurged = purged.length;
  const keptPending = out.filter(l => /^\s*-\s*\[ \]/.test(l)).length;
  console.log(`pipeline.md: purging ${pipelinePurged} pending URLs, keeping ${keptPending}`);
  if (!DRY_RUN && pipelinePurged > 0) writeAtomic(PIPELINE, out.join('\n'));
} else {
  console.log('pipeline.md: not found, skipping');
}

console.log('');
if (DRY_RUN) {
  console.log('[dry-run] No changes written.');
} else if (triagePurged === 0 && pipelinePurged === 0) {
  console.log('Nothing to purge.');
} else {
  console.log(`Purged ${triagePurged} inbox rows + ${pipelinePurged} pending URLs (backups: *.bak).`);
}
