#!/usr/bin/env node

/**
 * apply-audit.mjs — Apply audit-portals.mjs findings to portals.yml
 *
 * Two operations, both acting on portals.yml in place (backup written first):
 *
 *   1. SWITCH 36 high-confidence websearch → API companies to zero-cost
 *      structured scans (Greenhouse / Ashby / Lever).
 *   2. REMOVE legacy / non-AI-forward / non-builder-PM-culture companies
 *      from tracked_companies.
 *
 * Zero LLM tokens — pure string manipulation on YAML blocks.
 *
 * Usage: node apply-audit.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs';

const PATH = 'portals.yml';
const DRY = process.argv.includes('--dry-run');

// 36 confirmed API switches from audit run (postings > 0 on probed endpoint)
const SWITCHES = [
  { name: 'Aleph Alpha',             ats: 'lever',      slug: 'aleph' },
  { name: 'Attio',                   ats: 'ashby',      slug: 'attio' },
  { name: 'Bland AI',                ats: 'ashby',      slug: 'bland' },
  { name: 'Causaly',                 ats: 'ashby',      slug: 'causaly' },
  { name: 'Clarity AI',              ats: 'greenhouse', slug: 'clarityai' },
  { name: 'Clay Labs',               ats: 'ashby',      slug: 'claylabs' },
  { name: 'Clerk',                   ats: 'ashby',      slug: 'clerk' },
  { name: 'Databricks',              ats: 'greenhouse', slug: 'databricks' },
  { name: 'Decagon',                 ats: 'ashby',      slug: 'decagon' },
  { name: 'Deepgram',                ats: 'ashby',      slug: 'deepgram' },
  { name: 'DeepL',                   ats: 'ashby',      slug: 'deepl' },
  { name: 'Dialpad',                 ats: 'greenhouse', slug: 'dialpad' },
  { name: 'ElevenLabs',              ats: 'ashby',      slug: 'elevenlabs' },
  { name: 'Faculty',                 ats: 'ashby',      slug: 'faculty' },
  { name: 'Harvey',                  ats: 'ashby',      slug: 'harvey' },
  { name: 'Inngest',                 ats: 'ashby',      slug: 'inngest' },
  { name: 'Langfuse',                ats: 'ashby',      slug: 'langfuse' },
  { name: 'Legora',                  ats: 'ashby',      slug: 'legora' },
  { name: 'Lindy',                   ats: 'ashby',      slug: 'lindy' },
  { name: 'Linear',                  ats: 'ashby',      slug: 'linear' },
  { name: 'LivePerson',              ats: 'greenhouse', slug: 'liveperson' },
  { name: 'Lovable',                 ats: 'ashby',      slug: 'lovable' },
  { name: 'n8n',                     ats: 'ashby',      slug: 'n8n' },
  { name: 'OpenAI',                  ats: 'ashby',      slug: 'openai' },
  { name: 'Perplexity',              ats: 'ashby',      slug: 'perplexity' },
  { name: 'Photoroom',               ats: 'ashby',      slug: 'photoroom' },
  { name: 'Resend',                  ats: 'ashby',      slug: 'resend' },
  { name: 'Sierra',                  ats: 'ashby',      slug: 'sierra' },
  { name: 'Stripe Climate / Stripe', ats: 'greenhouse', slug: 'stripe' },
  { name: 'Supabase',                ats: 'ashby',      slug: 'supabase' },
  { name: 'Synthesia',               ats: 'ashby',      slug: 'synthesia' },
  { name: 'Tinybird',                ats: 'lever',      slug: 'tinybird' },
  { name: 'Twilio',                  ats: 'greenhouse', slug: 'twilio' },
  { name: 'Vapi',                    ats: 'ashby',      slug: 'vapi' },
  { name: 'WorkOS',                  ats: 'ashby',      slug: 'workos' },
  { name: 'Zapier',                  ats: 'ashby',      slug: 'zapier' },
];

// Removals: companies where archetype/culture doesn't match Adrian's target
// (Technical AI PM / builder-PM / modern dev-tool-adopting eng culture).
// Grouped by rationale so the list is auditable.
const REMOVALS = [
  // Legacy enterprise / pre-LLM conversational / traditional SaaS
  'Salesforce', 'Celonis', 'Contentful', 'Cognigy', 'Genesys', 'Talkdesk',

  // Non-tech verticals (travel, food, retail, logistics)
  'HelloFresh', 'GetYourGuide', 'Vinted', 'Travelperk', 'Forto', 'SumUp',

  // Hardware / physical / climate-physical (not software-PM fit)
  'Electric Hydrogen', 'Form Energy', 'Sila', 'Span',
  'Dandelion Energy', 'Pachama', 'Palmetto', 'Patch',
  'Persefoni', 'Recurve', 'WeaveGrid', 'Aurora Solar', 'Scandit',

  // EU legacy fintech / HR (already scoring low in triage + location/comp issues)
  'N26', 'Qonto', 'Trade Republic', 'Factorial',

  // Scored <3 on recent evaluations (evidence of non-fit)
  'Helsing',
];

// ── Utilities ───────────────────────────────────────────────────────

function findCompanyBlock(yaml, name) {
  // Line-based block finder. Returns { startLine, endLine, body } where
  // body is the full multi-line block text (name line + indented fields).
  const lines = yaml.split('\n');
  const startIdx = lines.findIndex(l => l === `  - name: ${name}`);
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^  - /.test(l)) { endIdx = i; break; }
    if (/^[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(l)) { endIdx = i; break; }
    if (/^  # --/.test(l)) { endIdx = i; break; }
  }
  // Trim trailing blank lines from the block body so the block is tight
  while (endIdx > startIdx + 1 && lines[endIdx - 1] === '') endIdx--;
  const body = lines.slice(startIdx, endIdx).join('\n');
  return { startLine: startIdx, endLine: endIdx, body };
}

function apiUrlFor(sw) {
  if (sw.ats === 'greenhouse') {
    return {
      careers_url: `https://job-boards.greenhouse.io/${sw.slug}`,
      api: `https://boards-api.greenhouse.io/v1/boards/${sw.slug}/jobs`,
    };
  }
  if (sw.ats === 'ashby') {
    return { careers_url: `https://jobs.ashbyhq.com/${sw.slug}` };
  }
  return { careers_url: `https://jobs.lever.co/${sw.slug}` };
}

function rewriteBlockForSwitch(body, sw) {
  // Body is the full "  - name: X\n    careers_url: ...\n    scan_method: websearch\n    scan_query: ...\n    notes: ...\n    enabled: true\n"
  const { careers_url, api } = apiUrlFor(sw);
  const lines = body.split('\n');
  const out = [];
  let injectedApi = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^    careers_url:/.test(line)) {
      out.push(`    careers_url: ${careers_url}`);
      if (api && !injectedApi) {
        out.push(`    api: ${api}`);
        injectedApi = true;
      }
      continue;
    }
    if (/^    api:/.test(line)) {
      if (api && !injectedApi) {
        out.push(`    api: ${api}`);
        injectedApi = true;
      }
      // drop existing api line (we replaced or removed it)
      continue;
    }
    if (/^    scan_method:\s*websearch/.test(line)) continue;     // drop
    if (/^    scan_query:/.test(line)) continue;                  // drop
    out.push(line);
  }
  return out.join('\n');
}

function removeBlock(yaml, name) {
  // Line-based removal: locate "  - name: X" on its own line, then consume
  // the block until the next entry boundary (another "  - " item, a top-level
  // YAML key, or a section comment at column 0/2).
  const lines = yaml.split('\n');
  const nameLine = `  - name: ${name}`;
  const startIdx = lines.findIndex(l => l.trim() === `- name: ${name}` || l === nameLine);
  if (startIdx === -1) return { yaml, removed: false };
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^  - /.test(l)) { endIdx = i; break; }           // next company entry
    if (/^[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(l)) { endIdx = i; break; } // top-level key
    if (/^  # --/.test(l)) { endIdx = i; break; }         // section comment
  }
  // Include one trailing blank line if present (to avoid double-blank gaps)
  if (endIdx < lines.length && lines[endIdx - 1] === '') endIdx -= 0; // already fine
  // Eat a single trailing blank line following the block
  let sliceEnd = endIdx;
  if (sliceEnd < lines.length && lines[sliceEnd] === '') sliceEnd++;
  const next = [...lines.slice(0, startIdx), ...lines.slice(sliceEnd)].join('\n');
  return { yaml: next, removed: true };
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  let yaml = readFileSync(PATH, 'utf8');
  const before = yaml;

  // Backup
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${PATH}.bak-${stamp}`;
  if (!DRY) copyFileSync(PATH, backup);

  // Step 1: Apply switches
  const switchLog = [];
  for (const sw of SWITCHES) {
    const block = findCompanyBlock(yaml, sw.name);
    if (!block) { switchLog.push(`NOT FOUND: ${sw.name}`); continue; }
    const newBody = rewriteBlockForSwitch(block.body, sw);
    yaml = yaml.replace(block.body, newBody);
    switchLog.push(`switched: ${sw.name} → ${sw.ats} (${sw.slug})`);
  }

  // Step 2: Remove companies
  const removeLog = [];
  for (const name of REMOVALS) {
    const { yaml: next, removed } = removeBlock(yaml, name);
    yaml = next;
    removeLog.push(`${removed ? 'removed ' : 'NOT FOUND'}: ${name}`);
  }

  // Report
  console.log('=== Switches ===');
  for (const l of switchLog) console.log(`  ${l}`);
  console.log(`\n=== Removals ===`);
  for (const l of removeLog) console.log(`  ${l}`);

  const byteDelta = Buffer.byteLength(yaml) - Buffer.byteLength(before);
  console.log(`\nBytes changed: ${byteDelta} (backup: ${DRY ? '(dry-run, none)' : backup})`);

  if (!DRY) writeFileSync(PATH, yaml);
}

main();
