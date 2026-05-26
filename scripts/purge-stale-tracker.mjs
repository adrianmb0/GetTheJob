#!/usr/bin/env node
// Purge stale rows from data/applications.md.
//
// A row is purged iff:
//   - status ∈ {Evaluated, Discarded, SKIP}
//   - date < today - MAX_AGE_DAYS (default 14)
//
// Active-pipeline statuses (Applied, Responded, Interview, Offer) and Rejected
// rows are preserved regardless of age.
//
// Writes a backup to data/applications.md.bak before mutating.
// Atomic: writes to a temp file and renames.
//
// Flags:
//   --dry-run   Print what would be purged; don't write
//   --days N    Override age threshold (default 14)

import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKER = join(ROOT, 'data', 'applications.md');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const daysFlagIdx = args.indexOf('--days');
const MAX_AGE_DAYS = daysFlagIdx >= 0 ? parseInt(args[daysFlagIdx + 1], 10) : 14;
if (!Number.isFinite(MAX_AGE_DAYS) || MAX_AGE_DAYS <= 0) {
  console.error('Invalid --days value');
  process.exit(2);
}

const PURGE_STATUSES = new Set(['Evaluated', 'Discarded', 'SKIP']);

if (!existsSync(TRACKER)) {
  console.error(`Not found: ${TRACKER}`);
  process.exit(1);
}

const today = new Date();
today.setHours(0, 0, 0, 0);
const cutoff = new Date(today.getTime() - MAX_AGE_DAYS * 86400_000);
const cutoffStr = cutoff.toISOString().slice(0, 10);

const original = readFileSync(TRACKER, 'utf8');
const lines = original.split('\n');

const headerIdx = lines.findIndex(l => /^\s*\|\s*#\s*\|/.test(l));
if (headerIdx === -1) {
  console.error('Tracker header row not found in applications.md');
  process.exit(1);
}
const header = lines[headerIdx].split('|').slice(1, -1).map(s => s.trim());
const dateCol = header.findIndex(h => /^date$/i.test(h));
const statusCol = header.findIndex(h => /^status$/i.test(h));
const companyCol = header.findIndex(h => /^company$/i.test(h));
const roleCol = header.findIndex(h => /^role$/i.test(h));
const numCol = header.findIndex(h => h === '#');
if (dateCol === -1 || statusCol === -1) {
  console.error('Required columns (Date, Status) not found');
  process.exit(1);
}

const out = [];
const purged = [];
const preserved = { byStatus: {}, byAge: 0 };

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Pass through anything that's not a data row
  if (i <= headerIdx + 1 || !/^\s*\|\s*\d+\s*\|/.test(line)) {
    out.push(line);
    continue;
  }
  const cells = line.split('|').slice(1, -1).map(s => s.trim());
  const date = cells[dateCol] || '';
  const status = cells[statusCol] || '';
  const num = cells[numCol] || '?';
  const company = cells[companyCol] || '?';
  const role = cells[roleCol] || '?';

  const eligibleStatus = PURGE_STATUSES.has(status);
  const isOld = /^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoffStr;

  if (eligibleStatus && isOld) {
    purged.push({ num, date, status, company, role });
    continue;
  }
  if (eligibleStatus && !isOld) preserved.byAge++;
  preserved.byStatus[status] = (preserved.byStatus[status] || 0) + 1;
  out.push(line);
}

console.log(`Cutoff: ${cutoffStr} (${MAX_AGE_DAYS} days ago)`);
console.log(`Purge-eligible statuses: ${[...PURGE_STATUSES].join(', ')}`);
console.log('');
console.log(`Purged: ${purged.length} rows`);
for (const p of purged) {
  console.log(`  #${p.num}  ${p.date}  ${p.status.padEnd(10)} ${p.company} — ${p.role.slice(0, 60)}`);
}
console.log('');
console.log(`Preserved by status:`);
for (const [s, n] of Object.entries(preserved.byStatus)) {
  console.log(`  ${s.padEnd(12)} ${n}`);
}
if (preserved.byAge > 0) {
  console.log(`  (${preserved.byAge} purge-eligible rows kept because they're <${MAX_AGE_DAYS}d old)`);
}

if (DRY_RUN) {
  console.log('\n[dry-run] No changes written.');
  process.exit(0);
}

if (purged.length === 0) {
  console.log('\nNothing to purge.');
  process.exit(0);
}

copyFileSync(TRACKER, TRACKER + '.bak');
const tmp = TRACKER + '.tmp';
writeFileSync(tmp, out.join('\n'));
renameSync(tmp, TRACKER);
console.log(`\nWrote ${TRACKER}`);
console.log(`Backup: ${TRACKER}.bak`);
