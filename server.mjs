#!/usr/bin/env node
// GetTheJob — job application dashboard
// Zero npm deps. Built-ins only: node:http, node:fs, node:path, node:url.
// Works standalone or pointed at a get-the-job data directory.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, renameSync, readdirSync, createReadStream, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const PORT = process.env.PORT || 3737;
const SRC_DIR = resolve(fileURLToPath(import.meta.url), '..');
const ROOT = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : SRC_DIR;
// One spelling of the product name, used by the setup wizard so its tab title and
// body copy can't drift apart. Matches the wordmark shell() already renders.
const PRODUCT_NAME = 'GetTheJob';

// Dev-only: when EPHEMERAL=1, wipe the generated user files before each page load
// so the onboarding wizard always starts fresh on refresh (for repeated testing
// with mock data). Hard-guarded to a sandbox DATA_DIR — it refuses to run when
// ROOT is the source tree, so it can NEVER touch your real data.
const EPHEMERAL = process.env.EPHEMERAL === '1' && ROOT !== SRC_DIR;
function wipeEphemeralData() {
  if (!EPHEMERAL || ROOT === SRC_DIR) return;
  for (const f of ['config/profile.yml', 'portals.yml', 'cv.md', 'cv.pdf', 'modes/_profile.md',
                   'data/applications.md', 'data/pipeline.md', 'data/triage-scores.tsv', 'data/scan-history.tsv']) {
    try { rmSync(join(ROOT, f), { force: true }); } catch { /* ignore */ }
  }
}

// Snapshot the user's personalization files into backups/setup-<timestamp>/ before
// the onboarding wizard overwrites them. Returns the backup's relative path, or
// null if there was nothing to back up (e.g. a genuine first-time setup). Never
// runs in EPHEMERAL sandboxes — those are meant to be disposable.
function backupUserFiles() {
  if (EPHEMERAL) return null;
  const files = ['config/profile.yml', 'portals.yml', 'cv.md', 'cv.pdf', 'modes/_profile.md', 'article-digest.md'];
  const present = files.filter(f => existsSync(join(ROOT, f)));
  if (!present.length) return null;
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const rel = join('backups', 'setup-' + stamp);
  try {
    for (const f of present) {
      const dest = join(ROOT, rel, f);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(ROOT, f), dest);
    }
    return rel;
  } catch { return null; }
}

// ----- re-running setup: read what is already on disk ------------------------
// The wizard is the product's own advice for adding a resume or a story later
// ("add it by re-running setup"), so a re-run must never be destructive. These
// readers turn the existing user files back into the wizard's own shape, which
// is used twice: to PREFILL every field, and (server-side) as the fallback for
// anything a submission leaves empty. Merge, never replace.

// Two guardrail lines in modes/_profile.md are generated from other answers
// (work preference, comp floor) rather than typed. They are recomputed on every
// save, so they must not be prefilled into the free-text "rule anything out" box
// nor preserved as if the user had written them.
const SYNTH_ONSITE_HARD = 'Roles that require regular on-site presence (you chose Remote only).';
const SYNTH_COMP_SOFT_PREFIX = 'Comp below your floor (';
// The wizard's avoid box is comma-separated, so a long or comma-containing rule
// (typically added in Settings → Scoring rules) cannot round-trip through it.
// Those are left out of the prefill and preserved untouched on save instead.
function isAvoidBoxItem(s) { return s.length <= 60 && s.indexOf(',') < 0; }

const ySt = v => (v == null || typeof v === 'object') ? '' : String(v);
const yArr = v => Array.isArray(v) ? v.map(x => ySt(x)).filter(Boolean) : [];

function loadYamlFile(rel) {
  try {
    const p = join(ROOT, rel);
    if (!existsSync(p)) return null;
    const d = yaml.load(readFileSync(p, 'utf8'));
    return (d && typeof d === 'object') ? d : null;
  } catch { return null; }
}

// True for the placeholder cv.md the wizard writes when no resume was supplied.
// Prefilling that scaffold back into the textarea would read as real content.
function isCvScaffold(text) {
  const t = String(text || '');
  if (!t.trim()) return true;
  return t.includes('not yet converted to Markdown') || t.includes('Your resume is not filled in yet');
}

function readCvText() {
  try {
    const p = join(ROOT, 'cv.md');
    if (!existsSync(p)) return '';
    const t = readFileSync(p, 'utf8');
    return isCvScaffold(t) ? '' : t;
  } catch { return ''; }
}

// Returns the wizard's own payload shape, or null on a genuine first run.
function readExistingSetup() {
  const prof = loadYamlFile('config/profile.yml');
  const portals = loadYamlFile('portals.yml');
  if (!prof && !portals) return null;
  const cand = (prof && prof.candidate) || {};
  const narr = (prof && prof.narrative) || {};
  const comp = (prof && prof.compensation) || {};
  const tr = (prof && prof.target_roles) || {};
  const prefs = (prof && prof.preferences) || {};
  const proof = Array.isArray(narr.proof_points) ? narr.proof_points : [];
  const p0 = (proof[0] && typeof proof[0] === 'object') ? proof[0] : {};
  const guard = readGuardrails();
  const wp = ySt(prefs.work_style);
  const stage = ySt(prof && prof.career_stage);
  const tracked = Array.isArray(portals && portals.tracked_companies) ? portals.tracked_companies : [];
  return {
    name: ySt(cand.full_name),
    email: ySt(cand.email),
    location: ySt(cand.location),
    linkedin: ySt(cand.linkedin),
    industries: yArr(prof && prof.industries),
    roles: yArr(tr.primary),
    // Both of these are deliberate choices, not absences: "open to any title in my
    // field" and "open on pay" have to come back as chosen, or a re-run would show
    // them as unanswered and quietly rebuild a filter the user turned off.
    titlesOpen: tr.flexible === true,
    careerStage: ['student', 'experienced'].includes(stage) ? stage : '',
    jobTypes: yArr(prof && prof.job_types).filter(t => JOB_TYPE_IDS.includes(t)),
    comp: ySt(comp.target_range),
    payOpen: comp.open === true,
    currency: ySt(comp.currency) || 'USD',
    workpref: ['remote', 'hybrid', 'onsite'].includes(wp) ? wp : 'hybrid',
    avoid: (guard.hard || []).filter(s => s !== SYNTH_ONSITE_HARD && isAvoidBoxItem(s)).join(', '),
    companies: tracked.filter(c => c && c.name && c.careers_url).map(c => {
      const o = { name: ySt(c.name), careers_url: ySt(c.careers_url) };
      if (c.api) o.api = ySt(c.api);
      return o;
    }),
    cv: readCvText(),
    headline: ySt(narr.headline),
    exitStory: ySt(narr.exit_story),
    strengths: yArr(narr.superpowers),
    proofName: ySt(p0.name),
    proofMetric: ySt(p0.hero_metric),
    proofDetail: ySt(p0.description),
  };
}

// JSON for embedding in a <script>: '<' must not be able to close the tag, and
// U+2028/9 are line terminators in JS source but legal inside a JSON string.
function jsonForScript(v) {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Serialize keys the wizard does not manage so hand-added YAML survives a re-run.
function dumpExtraKeys(obj, managed, indent) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const extra = {};
  for (const k of Object.keys(obj)) if (!managed.includes(k)) extra[k] = obj[k];
  if (!Object.keys(extra).length) return '';
  const pad = ' '.repeat(indent);
  return yaml.dump(extra, { lineWidth: 120 })
    .split('\n').filter(l => l.length)
    .map(l => pad + l).join('\n') + '\n';
}

// ----- auto-fix GetTheJob.app permissions on startup -----
const APP_LAUNCHER = join(ROOT, 'GetTheJob.app', 'Contents', 'MacOS', 'GetTheJob');
if (existsSync(APP_LAUNCHER)) {
  try {
    const st = statSync(APP_LAUNCHER);
    if (!(st.mode & 0o111)) spawnSync('chmod', ['+x', APP_LAUNCHER]);
    spawnSync('xattr', ['-cr', join(ROOT, 'GetTheJob.app')], { stdio: 'ignore' });
  } catch (_) { /* non-critical */ }
}

// ----- onboarding data -----

const INDUSTRIES = [
  { id: 'tech', label: 'Technology & Software', icon: '💻' },
  { id: 'finance', label: 'Finance & Fintech', icon: '📊' },
  { id: 'health', label: 'Healthcare & Biotech', icon: '🏥' },
  { id: 'legal', label: 'Legal & Compliance', icon: '⚖️' },
  { id: 'climate', label: 'Climate & Energy', icon: '🌱' },
  { id: 'education', label: 'Education & EdTech', icon: '📚' },
  { id: 'media', label: 'Media & Entertainment', icon: '🎬' },
  { id: 'consulting', label: 'Consulting & Professional Services', icon: '🤝' },
  { id: 'government', label: 'Government & Public Sector', icon: '🏛️' },
  { id: 'retail', label: 'Retail & E-commerce', icon: '🛒' },
  { id: 'manufacturing', label: 'Manufacturing & Supply Chain', icon: '🏭' },
  { id: 'other', label: 'Other', icon: '🔧' },
];

const ROLE_SUGGESTIONS = {
  tech: ['Software Engineer', 'Senior Software Engineer', 'Staff Engineer', 'Frontend Engineer', 'Backend Engineer', 'Full-Stack Engineer', 'DevOps Engineer', 'Site Reliability Engineer', 'ML Engineer', 'AI Engineer', 'Data Engineer', 'Platform Engineer', 'Solutions Architect', 'Product Manager', 'Technical Program Manager', 'Engineering Manager', 'CTO', 'VP of Engineering', 'Developer Advocate', 'QA Engineer'],
  finance: ['Financial Analyst', 'Quantitative Analyst', 'Risk Analyst', 'Portfolio Manager', 'Investment Banker', 'Compliance Officer', 'Fintech Product Manager', 'Data Analyst', 'Actuary', 'Treasury Analyst', 'Credit Analyst', 'Audit Manager'],
  health: ['Registered Nurse', 'Nurse Practitioner', 'Clinical Nurse Specialist', 'Care Coordinator', 'Clinical Research Coordinator', 'Clinical Data Analyst', 'Health Informatics Specialist', 'Healthcare Administrator', 'Practice Manager', 'Physician Assistant', 'Physical Therapist', 'Pharmacist', 'Public Health Analyst', 'Bioinformatics Engineer', 'Biostatistician', 'Regulatory Affairs Specialist', 'Medical Science Liaison', 'Clinical Research Associate', 'Healthcare Product Manager', 'Computational Biologist', 'Pharmacovigilance Analyst'],
  legal: ['Paralegal', 'Corporate Paralegal', 'Legal Assistant', 'Legal Analyst', 'Legal Operations Manager', 'Contract Manager', 'Contracts Administrator', 'Compliance Manager', 'Compliance Analyst', 'Privacy Officer', 'Legal Counsel', 'Policy Analyst', 'Regulatory Specialist', 'eDiscovery Analyst', 'IP Analyst'],
  climate: ['Sustainability Analyst', 'Energy Engineer', 'Climate Data Scientist', 'Environmental Consultant', 'Carbon Markets Analyst', 'Clean Energy Product Manager', 'ESG Analyst', 'Grid Optimization Engineer', 'Renewable Energy Specialist'],
  education: ['Teacher', 'Elementary Teacher', 'High School Teacher', 'Special Education Teacher', 'Teaching Assistant', 'School Counselor', 'Curriculum Designer', 'Instructional Designer', 'EdTech Product Manager', 'Learning Engineer', 'Data Analyst', 'Academic Advisor', 'Admissions Counselor', 'Education Program Manager', 'Assessment Specialist', 'Online Course Developer'],
  media: ['Content Strategist', 'Product Manager', 'Data Analyst', 'UX Designer', 'Growth Manager', 'Marketing Manager', 'Creative Director', 'Video Producer', 'Audience Development Manager'],
  consulting: ['Management Consultant', 'Strategy Consultant', 'Business Analyst', 'Technology Consultant', 'Implementation Consultant', 'Project Manager', 'Solutions Consultant', 'Digital Transformation Lead', 'Change Management Consultant'],
  government: ['Policy Analyst', 'Data Analyst', 'Program Manager', 'IT Specialist', 'Grants Manager', 'Urban Planner', 'Public Affairs Specialist', 'Intelligence Analyst', 'Cybersecurity Analyst'],
  retail: ['E-commerce Manager', 'Supply Chain Analyst', 'Merchandising Analyst', 'Product Manager', 'Data Analyst', 'Category Manager', 'Logistics Coordinator', 'Demand Planner', 'Digital Marketing Manager'],
  manufacturing: ['Supply Chain Manager', 'Process Engineer', 'Quality Engineer', 'Operations Manager', 'Manufacturing Engineer', 'Industrial Engineer', 'Automation Engineer', 'Production Planner', 'Logistics Manager'],
  other: ['Project Manager', 'Product Manager', 'Data Analyst', 'Business Analyst', 'Operations Manager', 'Marketing Manager', 'UX Designer', 'Software Engineer', 'Customer Success Manager', 'Account Executive', 'Recruiter', 'Executive Assistant', 'Office Manager', 'Accountant', 'Content Writer'],
};

// What someone at the start of their career is looking for. Offered only when
// "Student / early career" is picked, because each type carries its own title
// vocabulary: boards post a co-op as "Co-op" or "Placement Student", never as
// "Junior Software Engineer", so a filter built from ROLE_SUGGESTIONS alone would
// drop every one of them.
const JOB_TYPES = [
  { id: 'internship', label: 'Internship', icon: '🗓️',
    titles: ['Intern', 'Internship', 'Summer Intern', 'Summer Analyst'] },
  { id: 'coop', label: 'Co-op / placement', icon: '🔁',
    titles: ['Co-op', 'Co-op Student', 'Placement Student', 'Industrial Placement'] },
  { id: 'part_time', label: 'Working student / part-time', icon: '🕐',
    titles: ['Working Student', 'Student Assistant', 'Student Worker', 'Part-Time Assistant'] },
  { id: 'graduate', label: 'Graduate / entry-level', icon: '🎯',
    titles: ['Graduate', 'New Grad', 'Graduate Program', 'Entry Level', 'Junior', 'Trainee', 'Apprentice'] },
];
const JOB_TYPE_IDS = JOB_TYPES.map(t => t.id);
const JOB_TYPE_LABELS = JOB_TYPES.reduce((m, t) => { m[t.id] = t.label; return m; }, {});

// The title words for the job types picked, or every early-career word when a
// student picked none — a student who skips this question still must not have
// internships filtered out from under them.
function studentTitleSeeds(jobTypes) {
  const ids = (Array.isArray(jobTypes) && jobTypes.length) ? jobTypes : JOB_TYPE_IDS;
  const out = [];
  JOB_TYPES.forEach(t => { if (ids.includes(t.id)) t.titles.forEach(x => { if (!out.includes(x)) out.push(x); }); });
  return out;
}

// Title keywords each career stage rules out, and the ones it prioritizes.
//
// scan.mjs matches these as plain substrings, so a keyword is only safe here if no
// early-career title contains it. That rules out several obvious candidates:
// "Staff" would drop "Staff Accountant" and "Staff Nurse" (both entry-level), and
// "Lead" would drop "Lead Generation Intern". Hence the wordier "Director of" /
// "VP of" spellings rather than the bare titles.
const STAGE_TITLE_RULES = {
  experienced: {
    negative: ['Junior', 'Intern', 'Internship'],
    boost: ['Senior', 'Staff', 'Principal', 'Lead', 'Head'],
  },
  student: {
    negative: ['Senior', 'Director of', 'Head of', 'VP of', 'Vice President'],
    boost: ['Intern', 'Internship', 'Co-op', 'Graduate', 'New Grad', 'Junior', 'Working Student', 'Trainee', 'Apprentice'],
  },
};

// Career-changer vocabulary: what someone types when they only know their CURRENT
// title ("I'm a nurse — what do I search for?") mapped to target titles they'd
// never think to type. Matched alongside ROLE_SUGGESTIONS so the suggestion list
// is never empty for a non-tech user.
const ROLE_ALIASES = {
  nurse: ['Registered Nurse', 'Nurse Practitioner', 'Clinical Nurse Specialist', 'Clinical Research Coordinator', 'Clinical Data Analyst', 'Health Informatics Specialist'],
  nursing: ['Registered Nurse', 'Nurse Practitioner', 'Care Coordinator', 'Clinical Research Coordinator'],
  patient: ['Care Coordinator', 'Patient Access Coordinator', 'Healthcare Administrator', 'Practice Manager'],
  clinic: ['Practice Manager', 'Healthcare Administrator', 'Care Coordinator'],
  doctor: ['Physician Assistant', 'Medical Science Liaison', 'Clinical Research Associate'],
  pharmacy: ['Pharmacist', 'Pharmacovigilance Analyst', 'Regulatory Affairs Specialist'],
  teacher: ['Teacher', 'Special Education Teacher', 'Curriculum Designer', 'Instructional Designer', 'Education Program Manager'],
  teaching: ['Teacher', 'Teaching Assistant', 'Instructional Designer', 'Learning Engineer'],
  school: ['Teacher', 'School Counselor', 'Academic Advisor', 'Education Program Manager'],
  paralegal: ['Paralegal', 'Corporate Paralegal', 'Legal Operations Manager', 'Contracts Administrator', 'Compliance Analyst'],
  lawyer: ['Legal Counsel', 'Compliance Manager', 'Legal Operations Manager', 'Contract Manager'],
  attorney: ['Legal Counsel', 'Compliance Manager', 'Legal Operations Manager'],
  law: ['Paralegal', 'Legal Analyst', 'Legal Operations Manager', 'Legal Counsel'],
  accountant: ['Accountant', 'Financial Analyst', 'Audit Manager', 'Credit Analyst'],
  accounting: ['Accountant', 'Financial Analyst', 'Audit Manager'],
  sales: ['Account Executive', 'Sales Manager', 'Customer Success Manager', 'Business Development Manager'],
  marketing: ['Marketing Manager', 'Digital Marketing Manager', 'Growth Manager', 'Content Strategist'],
  recruiter: ['Recruiter', 'Technical Recruiter', 'Talent Acquisition Manager'],
  recruiting: ['Recruiter', 'Technical Recruiter', 'Talent Acquisition Manager'],
  hr: ['HR Business Partner', 'People Operations Manager', 'Recruiter'],
  writer: ['Content Writer', 'Content Strategist', 'Technical Writer', 'Editor'],
  writing: ['Content Writer', 'Content Strategist', 'Technical Writer'],
  designer: ['UX Designer', 'Product Designer', 'Graphic Designer', 'Instructional Designer'],
  support: ['Customer Success Manager', 'Technical Support Specialist', 'Support Engineer'],
  military: ['Program Manager', 'Operations Manager', 'Logistics Manager', 'Intelligence Analyst'],
  veteran: ['Program Manager', 'Operations Manager', 'Logistics Manager'],
  admin: ['Executive Assistant', 'Office Manager', 'Operations Coordinator'],
  assistant: ['Executive Assistant', 'Legal Assistant', 'Teaching Assistant', 'Medical Assistant'],
  retail: ['Store Manager', 'Category Manager', 'Merchandising Analyst', 'E-commerce Manager'],
  restaurant: ['Operations Manager', 'Store Manager', 'Program Manager'],
  driver: ['Logistics Coordinator', 'Operations Coordinator', 'Demand Planner'],
  data: ['Data Analyst', 'Data Engineer', 'Business Analyst', 'Analytics Engineer'],
};

// Curated companies the onboarding wizard offers per industry. Every careers_url
// points at a Greenhouse/Ashby/Lever board so scan.mjs can detect the API and
// actually return jobs. Entries added or changed on 2026-07-29 were re-checked
// against their ATS endpoint that day and returned a non-zero job count; older
// entries have not been re-verified since they were added, so a dead slug is
// possible — the wizard surfaces boards that return nothing as a warning rather
// than pretending. Users can also paste any Greenhouse/Ashby/Lever URL.
// Only three industries have no curated list on purpose (government, other, and
// anything not keyed here): public-sector employers are almost all on Workday or
// USAJOBS, which this scanner cannot read. renderCompanies() says so out loud
// instead of silently showing an unrelated list.
const COMPANY_CATALOG = {
  tech: [
    { name: "Anthropic", careers_url: "https://job-boards.greenhouse.io/anthropic", api: "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs" },
    { name: "Cohere", careers_url: "https://jobs.ashbyhq.com/cohere" },
    // Removed 2026-07-31 after curling every endpoint in this catalog:
    // Mistral AI (jobs.lever.co/mistral → 200 but an empty array — they moved off
    // Lever), Runway (boards-api…/runwayml → 404; the live jobs.ashbyhq.com/runway
    // is a different company, a finance-software startup) and Vinted
    // (jobs.lever.co/vinted → 404). A board that returns nothing is worse than
    // absent: it silently shrinks the scan while looking configured.
    { name: "Perplexity", careers_url: "https://jobs.ashbyhq.com/perplexity" },
    { name: "ElevenLabs", careers_url: "https://jobs.ashbyhq.com/elevenlabs" },
    { name: "Vercel", careers_url: "https://job-boards.greenhouse.io/vercel", api: "https://boards-api.greenhouse.io/v1/boards/vercel/jobs" },
    { name: "Zapier", careers_url: "https://jobs.ashbyhq.com/zapier" },
    { name: "Airtable", careers_url: "https://job-boards.greenhouse.io/airtable", api: "https://boards-api.greenhouse.io/v1/boards/airtable/jobs" },
    { name: "Supabase", careers_url: "https://jobs.ashbyhq.com/supabase" },
    { name: "Palantir", careers_url: "https://jobs.lever.co/palantir" },
    { name: "Glean", careers_url: "https://job-boards.greenhouse.io/gleanwork", api: "https://boards-api.greenhouse.io/v1/boards/gleanwork/jobs" },
    { name: "Synthesia", careers_url: "https://jobs.ashbyhq.com/synthesia" },
    { name: "DeepL", careers_url: "https://jobs.ashbyhq.com/DeepL" },
    { name: "Spotify", careers_url: "https://jobs.lever.co/spotify" },
    { name: "Intercom", careers_url: "https://job-boards.greenhouse.io/intercom", api: "https://boards-api.greenhouse.io/v1/boards/intercom/jobs" },
    // Repointed 2026-07-31: the `temporal` Greenhouse slug 404s; the live board is
    // `temporaltechnologies` (56 roles).
    { name: "Temporal", careers_url: "https://job-boards.greenhouse.io/temporaltechnologies", api: "https://boards-api.greenhouse.io/v1/boards/temporaltechnologies/jobs" },
    { name: "Pinecone", careers_url: "https://jobs.ashbyhq.com/pinecone" },
    { name: "n8n", careers_url: "https://jobs.ashbyhq.com/n8n" },
  ],
  finance: [
    { name: "Stripe", careers_url: "https://job-boards.greenhouse.io/stripe", api: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs" },
    { name: "Plaid", careers_url: "https://jobs.ashbyhq.com/plaid" },
    { name: "Brex", careers_url: "https://job-boards.greenhouse.io/brex", api: "https://boards-api.greenhouse.io/v1/boards/brex/jobs" },
    { name: "Ramp", careers_url: "https://jobs.ashbyhq.com/ramp" },
    { name: "Chime", careers_url: "https://job-boards.greenhouse.io/chime", api: "https://boards-api.greenhouse.io/v1/boards/chime/jobs" },
    { name: "Affirm", careers_url: "https://job-boards.greenhouse.io/affirm", api: "https://boards-api.greenhouse.io/v1/boards/affirm/jobs" },
    { name: "Robinhood", careers_url: "https://job-boards.greenhouse.io/robinhood", api: "https://boards-api.greenhouse.io/v1/boards/robinhood/jobs" },
    { name: "Coinbase", careers_url: "https://job-boards.greenhouse.io/coinbase", api: "https://boards-api.greenhouse.io/v1/boards/coinbase/jobs" },
    { name: "Gusto", careers_url: "https://job-boards.greenhouse.io/gusto", api: "https://boards-api.greenhouse.io/v1/boards/gusto/jobs" },
    { name: "Carta", careers_url: "https://job-boards.greenhouse.io/carta", api: "https://boards-api.greenhouse.io/v1/boards/carta/jobs" },
    { name: "Mercury", careers_url: "https://job-boards.greenhouse.io/mercury", api: "https://boards-api.greenhouse.io/v1/boards/mercury/jobs" },
    { name: "Betterment", careers_url: "https://job-boards.greenhouse.io/betterment", api: "https://boards-api.greenhouse.io/v1/boards/betterment/jobs" },
    { name: "Wealthfront", careers_url: "https://jobs.lever.co/wealthfront" },
    { name: "Marqeta", careers_url: "https://job-boards.greenhouse.io/marqeta", api: "https://boards-api.greenhouse.io/v1/boards/marqeta/jobs" },
    { name: "Modern Treasury", careers_url: "https://jobs.ashbyhq.com/moderntreasury" },
    { name: "Clearco", careers_url: "https://jobs.ashbyhq.com/clearco" },
    { name: "Public", careers_url: "https://job-boards.greenhouse.io/public", api: "https://boards-api.greenhouse.io/v1/boards/public/jobs" },
    { name: "Alpaca", careers_url: "https://job-boards.greenhouse.io/alpaca", api: "https://boards-api.greenhouse.io/v1/boards/alpaca/jobs" },
  ],
  // Health: US health-tech, telehealth and insurance employers whose boards live on
  // Greenhouse/Ashby/Lever. NOT hospitals, health systems or the NHS — those are on
  // Workday/TRAC/Trac Jobs and cannot be read by an API scanner. renderCompanies()
  // says this out loud so nobody finishes setup expecting ward jobs.
  // Lyra Health, SonderMind, Parsley Health, Talkspace and Wheel added 2026-07-31
  // (verified live) because they are the ones that actually post licensed-clinician
  // roles rather than only software/GTM ones.
  health: [
    { name: "Oscar Health", careers_url: "https://job-boards.greenhouse.io/oscar", api: "https://boards-api.greenhouse.io/v1/boards/oscar/jobs" },
    { name: "Lyra Health", careers_url: "https://jobs.lever.co/lyrahealth" },
    { name: "SonderMind", careers_url: "https://jobs.ashbyhq.com/sondermind" },
    { name: "Parsley Health", careers_url: "https://job-boards.greenhouse.io/parsleyhealth", api: "https://boards-api.greenhouse.io/v1/boards/parsleyhealth/jobs" },
    { name: "Talkspace", careers_url: "https://job-boards.greenhouse.io/talkspace", api: "https://boards-api.greenhouse.io/v1/boards/talkspace/jobs" },
    { name: "Wheel", careers_url: "https://jobs.ashbyhq.com/wheel" },
    { name: "Ro", careers_url: "https://jobs.lever.co/ro" },
    // Zocdoc (54 roles) + Hinge Health (77) verified 2026-07-29. They replace a
    // "Cedar" entry whose Ashby slug actually served a home-services company.
    { name: "Zocdoc", careers_url: "https://job-boards.greenhouse.io/zocdoc", api: "https://boards-api.greenhouse.io/v1/boards/zocdoc/jobs" },
    { name: "Hinge Health", careers_url: "https://jobs.ashbyhq.com/hinge-health" },
    { name: "Benchling", careers_url: "https://jobs.ashbyhq.com/benchling" },
    { name: "Included Health", careers_url: "https://jobs.lever.co/includedhealth" },
    { name: "Maven Clinic", careers_url: "https://job-boards.greenhouse.io/mavenclinic", api: "https://boards-api.greenhouse.io/v1/boards/mavenclinic/jobs" },
    { name: "Headway", careers_url: "https://jobs.ashbyhq.com/headway" },
    { name: "Komodo Health", careers_url: "https://job-boards.greenhouse.io/komodohealth", api: "https://boards-api.greenhouse.io/v1/boards/komodohealth/jobs" },
    { name: "Commure", careers_url: "https://jobs.ashbyhq.com/commure" },
  ],
  // Education: ed-tech employers, not schools, colleges or universities (those are on
  // Workday/Taleo or their own ATS). Coursera removed 2026-07-31 — its Greenhouse
  // board 404s and no replacement slug resolves.
  education: [
    { name: "Duolingo", careers_url: "https://job-boards.greenhouse.io/duolingo", api: "https://boards-api.greenhouse.io/v1/boards/duolingo/jobs" },
    { name: "Udemy", careers_url: "https://job-boards.greenhouse.io/udemy", api: "https://boards-api.greenhouse.io/v1/boards/udemy/jobs" },
    { name: "Outschool", careers_url: "https://job-boards.greenhouse.io/outschool", api: "https://boards-api.greenhouse.io/v1/boards/outschool/jobs" },
    { name: "Guild", careers_url: "https://job-boards.greenhouse.io/guild", api: "https://boards-api.greenhouse.io/v1/boards/guild/jobs" },
    { name: "Newsela", careers_url: "https://job-boards.greenhouse.io/newsela", api: "https://boards-api.greenhouse.io/v1/boards/newsela/jobs" },
    { name: "NerdWallet", careers_url: "https://jobs.ashbyhq.com/nerdwallet" },
    { name: "Multiverse", careers_url: "https://jobs.ashbyhq.com/multiverse" },
    { name: "Handshake", careers_url: "https://jobs.ashbyhq.com/handshake" },
  ],
  // Removed 2026-07-31 — three slugs served a different company of the same name
  // (the same defect as the old "Cedar" entry, so the surviving comments here were
  // not trusted either): `lever.co/arcadia` is Arcadia the healthcare-analytics
  // company, `lever.co/sila` is Sila Services (HVAC/plumbing home services, 201
  // trade roles) not Sila Nanotechnologies, and `greenhouse/palmetto` is Palmetto
  // Animal Hospital in Florence SC (1 vet-student posting) not Palmetto solar.
  climate: [
    { name: "Watershed", careers_url: "https://job-boards.greenhouse.io/watershed", api: "https://boards-api.greenhouse.io/v1/boards/watershed/jobs" },
    { name: "Form Energy", careers_url: "https://jobs.ashbyhq.com/formenergy" },
    { name: "Crusoe", careers_url: "https://jobs.ashbyhq.com/crusoe" },
    { name: "Redwood Materials", careers_url: "https://job-boards.greenhouse.io/redwoodmaterials", api: "https://boards-api.greenhouse.io/v1/boards/redwoodmaterials/jobs" },
    { name: "Charm Industrial", careers_url: "https://jobs.lever.co/charmindustrial" },
    { name: "Aurora Solar", careers_url: "https://jobs.ashbyhq.com/aurorasolar" },
    { name: "SPAN", careers_url: "https://jobs.ashbyhq.com/span" },
    { name: "Twelve", careers_url: "https://jobs.ashbyhq.com/twelve" },
  ],
  media: [
    { name: "Patreon", careers_url: "https://jobs.ashbyhq.com/patreon" },
    { name: "Vox Media", careers_url: "https://job-boards.greenhouse.io/voxmedia", api: "https://boards-api.greenhouse.io/v1/boards/voxmedia/jobs" },
    { name: "The Athletic", careers_url: "https://jobs.lever.co/theathletic" },
    { name: "Discord", careers_url: "https://job-boards.greenhouse.io/discord", api: "https://boards-api.greenhouse.io/v1/boards/discord/jobs" },
    { name: "Cameo", careers_url: "https://job-boards.greenhouse.io/cameo", api: "https://boards-api.greenhouse.io/v1/boards/cameo/jobs" },
    { name: "Fandom", careers_url: "https://job-boards.greenhouse.io/fandom", api: "https://boards-api.greenhouse.io/v1/boards/fandom/jobs" },
    { name: "Musixmatch", careers_url: "https://jobs.lever.co/musixmatch" },
  ],
  retail: [
    { name: "Instacart", careers_url: "https://job-boards.greenhouse.io/instacart", api: "https://boards-api.greenhouse.io/v1/boards/instacart/jobs" },
    { name: "Faire", careers_url: "https://job-boards.greenhouse.io/faire", api: "https://boards-api.greenhouse.io/v1/boards/faire/jobs" },
    { name: "Glossier", careers_url: "https://job-boards.greenhouse.io/glossier", api: "https://boards-api.greenhouse.io/v1/boards/glossier/jobs" },
    { name: "Gopuff", careers_url: "https://jobs.lever.co/gopuff" },
    { name: "StockX", careers_url: "https://job-boards.greenhouse.io/stockx", api: "https://boards-api.greenhouse.io/v1/boards/stockx/jobs" },
    { name: "OLIPOP", careers_url: "https://job-boards.greenhouse.io/olipop", api: "https://boards-api.greenhouse.io/v1/boards/olipop/jobs" },
    // "Ritual" removed 2026-07-31: that Greenhouse slug is Ritual the crypto
    // protocol company (Core Protocol Engineer, Ecosystem Engineer), not the
    // consumer vitamin brand this list meant.
  ],
  // Legal & compliance: legal-tech employers plus firms that hire in-house legal
  // and legal-ops staff on a readable board. Counts verified 2026-07-29:
  // Harvey 348 (68 legal-titled), Everlaw 33, OneTrust 92, Axiom 18, CS Disco 28,
  // Rocket Lawyer 6. Anthropic/Stripe/Coinbase are here too because their
  // in-house legal, privacy and compliance teams post on the same boards.
  legal: [
    { name: "Harvey", careers_url: "https://jobs.ashbyhq.com/harvey" },
    // Added 2026-07-31 (verified live): Filevine 118, Juro 3 (UK legal counsel).
    { name: "Filevine", careers_url: "https://jobs.lever.co/filevine" },
    { name: "Juro", careers_url: "https://jobs.ashbyhq.com/juro" },
    { name: "Everlaw", careers_url: "https://job-boards.greenhouse.io/everlaw", api: "https://boards-api.greenhouse.io/v1/boards/everlaw/jobs" },
    { name: "OneTrust", careers_url: "https://job-boards.greenhouse.io/onetrust", api: "https://boards-api.greenhouse.io/v1/boards/onetrust/jobs" },
    { name: "Axiom", careers_url: "https://job-boards.greenhouse.io/axiom", api: "https://boards-api.greenhouse.io/v1/boards/axiom/jobs" },
    { name: "CS Disco", careers_url: "https://job-boards.greenhouse.io/disco", api: "https://boards-api.greenhouse.io/v1/boards/disco/jobs" },
    { name: "Rocket Lawyer", careers_url: "https://job-boards.greenhouse.io/rocketlawyer", api: "https://boards-api.greenhouse.io/v1/boards/rocketlawyer/jobs" },
    { name: "Anthropic", careers_url: "https://job-boards.greenhouse.io/anthropic", api: "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs" },
    { name: "Stripe", careers_url: "https://job-boards.greenhouse.io/stripe", api: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs" },
    { name: "Coinbase", careers_url: "https://job-boards.greenhouse.io/coinbase", api: "https://boards-api.greenhouse.io/v1/boards/coinbase/jobs" },
  ],
  // Thin on purpose: the big consultancies are all on Workday/Taleo, which this
  // scanner can't read. renderCompanies() warns when a list is this short.
  consulting: [
    { name: "Thoughtworks", careers_url: "https://job-boards.greenhouse.io/thoughtworks", api: "https://boards-api.greenhouse.io/v1/boards/thoughtworks/jobs" },
    { name: "Palantir", careers_url: "https://jobs.lever.co/palantir" },
    { name: "Glean", careers_url: "https://job-boards.greenhouse.io/gleanwork", api: "https://boards-api.greenhouse.io/v1/boards/gleanwork/jobs" },
  ],
  manufacturing: [
    { name: "Lucid Motors", careers_url: "https://job-boards.greenhouse.io/lucidmotors", api: "https://boards-api.greenhouse.io/v1/boards/lucidmotors/jobs" },
    { name: "Shield AI", careers_url: "https://jobs.lever.co/shieldai" },
    // Repointed 2026-07-31: `greenhouse/figure` is Figure the mortgage/lending
    // fintech (Chief Credit Officer, Home Improvement & Solar BD). The robotics
    // manufacturer this list meant is `figureai` (120 roles).
    { name: "Figure AI", careers_url: "https://job-boards.greenhouse.io/figureai", api: "https://boards-api.greenhouse.io/v1/boards/figureai/jobs" },
    { name: "Formlabs", careers_url: "https://job-boards.greenhouse.io/formlabs", api: "https://boards-api.greenhouse.io/v1/boards/formlabs/jobs" },
    { name: "Markforged", careers_url: "https://job-boards.greenhouse.io/markforged", api: "https://boards-api.greenhouse.io/v1/boards/markforged/jobs" },
  ],
};

// Cross-industry starter boards, used when the user hasn't narrowed by field or
// when their field has no curated list. Always labelled as a starter set in the
// UI — never presented as "companies in your field".
const STARTER_COMPANY_KEYS = [
  ['tech', 'Anthropic'], ['finance', 'Stripe'], ['health', 'Oscar Health'],
  ['legal', 'Everlaw'], ['media', 'Discord'], ['retail', 'Instacart'],
  ['education', 'Duolingo'], ['climate', 'Watershed'], ['consulting', 'Thoughtworks'],
  ['manufacturing', 'Lucid Motors'], ['tech', 'Vercel'], ['finance', 'Ramp'],
  ['health', 'Zocdoc'], ['tech', 'Zapier'], ['legal', 'OneTrust'],
];
const STARTER_COMPANIES = STARTER_COMPANY_KEYS
  .map(([ind, name]) => (COMPANY_CATALOG[ind] || []).find(c => c.name === name))
  .filter(Boolean);

// Expand a target role into the title keywords scan.mjs matches on.
//
// Two earlier versions of this both failed, in opposite directions:
//   1. the literal phrase only ("Clinical Data Analyst") matched almost no real
//      title, because boards write them inverted — "Analyst, Clinical Data";
//   2. every trailing n-gram down to the head noun, which emitted bare
//      "Analyst" / "Engineer" / "Manager" and matched anything. Measured on live
//      boards that kept 697/1824 tech titles ("Support Engineer", "Data Center
//      Electrical Engineer") and gave a nurse seven Regulatory-Affairs and
//      Sales-Operations analyst roles and zero clinical ones.
//
// The middle ground needs both halves to change: keywords keep the domain
// qualifier, and scan.mjs matches a keyword's WORDS in any order rather than as a
// substring (see buildTitleFilter there). So "backend engineer" still finds
// "Software Engineer, Backend" but never "Support Engineer".
//
// From "Clinical Data Analyst" we emit:
//   clinical data analyst   (the whole thing)
//   clinical analyst        qualifier + head, one per meaningful qualifier
//   data analyst
//   clinical data           the qualifiers alone — the domain, any head noun
// and deliberately NOT "analyst": a bare generic head noun is only emitted when
// it is the entire role the user typed (someone who writes just "Engineer" has
// asked for the wide net).
const GENERIC_HEAD_NOUNS = new Set([
  'analyst', 'engineer', 'engineering', 'manager', 'management', 'specialist',
  'coordinator', 'associate', 'director', 'lead', 'leader', 'consultant',
  'developer', 'designer', 'scientist', 'architect', 'administrator', 'officer',
  'advisor', 'adviser', 'representative', 'agent', 'assistant', 'technician',
  'executive', 'partner', 'strategist', 'generalist', 'supervisor', 'operator',
  'professional', 'staff', 'head', 'chief', 'intern', 'apprentice', 'trainee',
  'expert', 'operations', 'ops', 'support', 'senior', 'junior', 'principal',
  'vp', 'vice', 'president', 'member', 'contributor',
]);

function expandRoleKeywords(roles) {
  const STOP = new Set(['of', 'and', 'or', 'the', 'a', 'an', 'in', 'at', 'for', 'to', 'with', '&', 'i', 'ii', 'iii', 'iv', 'sr', 'jr']);
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const v = String(s || '').trim().replace(/[,;/]+$/, '');
    if (!v) return;
    const k = v.toLowerCase();
    if (k.length < 3 || STOP.has(k) || seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  (roles || []).forEach(raw => {
    // Split things people type as one field: "Backend Engineer, Platform Engineer"
    String(raw || '').split(/\s*,\s*|\s+(?:and|or|\/)\s+/i).forEach(phrase => {
      const words = phrase.trim().split(/\s+/).filter(Boolean)
        .filter(w => !STOP.has(w.toLowerCase()));
      if (!words.length) return;
      push(words.join(' '));
      if (words.length === 1) return;
      const head = words[words.length - 1];
      const quals = words.slice(0, -1).filter(w => !GENERIC_HEAD_NOUNS.has(w.toLowerCase()));
      quals.forEach(q => push(q + ' ' + head));
      if (quals.length >= 2) push(quals.join(' '));
      // A domain head noun ("Nurse", "Paralegal", "Pharmacist") is worth keeping
      // on its own; a generic one is not.
      if (!GENERIC_HEAD_NOUNS.has(head.toLowerCase())) push(head);
    });
  });
  return out;
}

// ----- helpers -----

// True if a YYYY-MM-DD date is today or at most `days` days ago. Used to expire
// the "NEW" highlight in the Inbox/Pipeline so a stale batch (no scan in a while)
// stops being flagged as new once it's more than `days` days old.
function withinDays(dateStr, days) {
  const s = (dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  const then = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const ageDays = Math.round((today - then) / 86400000);
  return ageDays >= 0 && ageDays <= days;
}

// Detect a Greenhouse/Ashby/Lever board from a pasted careers URL and derive the
// API endpoint + a display name. Mirrors scan.mjs's detectApi so the onboarding
// "add a company" field only accepts boards the scanner can actually read.
// Returns null if the URL isn't a recognized board.
function detectAtsFromUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let host, path;
  try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname; }
  catch { return null; }
  const slugOf = () => (path.split('/').filter(Boolean)[0] || '').trim();
  const titleize = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    const slug = slugOf(); if (!slug) return null;
    return { type: 'ashby', name: titleize(slug), careers_url: `https://jobs.ashbyhq.com/${slug}`,
      api: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true` };
  }
  if (/(^|\.)lever\.co$/.test(host)) {
    const slug = slugOf(); if (!slug) return null;
    return { type: 'lever', name: titleize(slug), careers_url: `https://jobs.lever.co/${slug}`,
      api: `https://api.lever.co/v0/postings/${slug}?mode=json` };
  }
  if (/greenhouse\.io$/.test(host)) {
    const slug = slugOf(); if (!slug) return null;
    return { type: 'greenhouse', name: titleize(slug), careers_url: `https://job-boards.greenhouse.io/${slug}`,
      api: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` };
  }
  return null;
}

// Hit a detected ATS API and return the live open-role count (null on failure).
async function countAtsJobs(detected) {
  try {
    const r = await fetch(detected.api, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (GetTheJob onboarding)' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (detected.type === 'lever') return Array.isArray(j) ? j.length : null;
    return Array.isArray(j.jobs) ? j.jobs.length : null;
  } catch { return null; }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scoreClass(scoreStr) {
  const m = String(scoreStr).match(/([0-9]+(\.[0-9]+)?)/);
  if (!m) return '';
  const n = parseFloat(m[1]);
  if (n >= 4.2) return 'score-high';
  if (n >= 3.5) return 'score-mid';
  if (n >= 2.5) return 'score-low';
  return 'score-skip';
}

function verdictClass(v) {
  const s = String(v || '').toUpperCase().trim();
  if (s === 'APPLY HIGH') return 'verdict-high';
  if (s === 'APPLY') return 'verdict-apply';
  if (s.startsWith('SKIP')) return 'verdict-skip';
  if (s === 'SUSPICIOUS') return 'verdict-warn';
  return 'verdict-other';
}

// ----- minimal markdown renderer (regex-based) -----
// Handles: headings, bold, italic, inline code, links, code fences,
// unordered/ordered lists, GFM tables, hr, blockquotes, paragraphs.

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const inline = (text) => {
    let t = escapeHtml(text);
    // inline code
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // links [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safeUrl = url.replace(/"/g, '&quot;');
      // local report link rewrite
      let href = safeUrl;
      if (/^reports\/[\w.\-]+\.md$/.test(safeUrl)) {
        href = `/report?file=${encodeURIComponent(safeUrl)}`;
      }
      return `<a href="${href}">${label}</a>`;
    });
    // bold then italic
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return t;
  };

  while (i < lines.length) {
    const line = lines[i];

    // code fence
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    // hr
    if (/^---+\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // GFM table
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*[-:|\s]+\|[-:|\s]+\|?\s*$/.test(lines[i + 1])) {
      const headerCells = line.split('|').slice(1, -1).map(s => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].split('|').slice(1, -1).map(s => s.trim());
        rows.push(cells);
        i++;
      }
      const thead = '<thead><tr>' + headerCells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead>';
      const tbody = '<tbody>' + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>';
      out.push(`<table class="md-table">${thead}${tbody}</table>`);
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map(it => `<li>${inline(it)}</li>`).join('') + '</ul>');
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map(it => `<li>${inline(it)}</li>`).join('') + '</ol>');
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // paragraph: collect until blank or block start
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return out.join('\n');
}

// ----- shared CSS / shell -----

const CSS = `
/* ===== Warm calm design system ===== */
:root {
  --canvas:#FAF8F4; --surface:#fff; --ink:#1F1D1B; --muted:#8A837A;
  --border:#EAE4DB; --hairline:#F0EBE3; --row-hover:#F5F1EB;
  --accent:#3D5A45; --accent-ink:#fff; --accent-weak:#EAF0EC;
  --good-bg:#E6F0E8; --good-ink:#3A6B45;
  --mid-bg:#E7EEF7;  --mid-ink:#3A5C86;
  --warn-bg:#F6EEDB; --warn-ink:#8A6516;
  --neutral-bg:#F0ECE6; --neutral-ink:#857B70;
  --danger:#A8553A;
  --header-bg:#fff; --header-ink:#1F1D1B;
  --seg-track:rgba(31,29,27,.06); --seg-ink:#8A837A; --seg-active-bg:#fff; --seg-active-ink:#1F1D1B;
  --shadow:0 1px 2px rgba(40,30,20,.04),0 6px 20px rgba(40,30,20,.05);
  /* legacy aliases (kept so untouched markup still resolves) */
  --bg:var(--canvas); --fg:var(--ink); --row-alt:var(--row-hover); --on-accent:var(--accent-ink);
  --high:var(--good-ink); --apply:var(--mid-ink); --skip:var(--neutral-ink); --warn:var(--warn-ink);
  --score-high-bg:var(--good-bg); --score-mid-bg:var(--mid-bg); --score-low-bg:var(--warn-bg); --score-skip-bg:var(--neutral-bg);
}
[data-theme="warm-dark"] {
  --canvas:#1A1816; --surface:#221F1C; --ink:#ECE7DF; --muted:#9C9389;
  --border:#322E29; --hairline:#2A2621; --row-hover:#24201C;
  --accent:#7FA587; --accent-ink:#15201A; --accent-weak:#1E2E22;
  --good-bg:#1E2E22; --good-ink:#84B891;
  --mid-bg:#20293A;  --mid-ink:#8FB0DE;
  --warn-bg:#33290F; --warn-ink:#D7A94B;
  --neutral-bg:#2A2622; --neutral-ink:#9C9389;
  --danger:#D98E6F;
  --header-bg:#1E1B18; --header-ink:#ECE7DF;
  --seg-track:rgba(255,255,255,.07); --seg-ink:#9C9389; --seg-active-bg:#332E29; --seg-active-ink:#ECE7DF;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.5);
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
  background: var(--canvas); color: var(--ink); margin: 0; padding: 0; line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  transition: background .2s ease, color .2s ease;
}
/* One page width for the whole app: the header bar and the page content read
   the same token, so the chrome lines up on every view and never reflows when
   you switch tabs. Full-bleed pages (apply) just override the token. */
body { --page-max: 1280px; }
.container { max-width: var(--page-max); margin: 0 auto; padding: 26px 28px 64px; }
a { color: var(--accent); }
h1 { font-size: 23px; margin: 0 0 16px; letter-spacing: -.02em; font-weight: 730; }
h2 { font-size: 17px; margin: 24px 0 8px; }
h3 { font-size: 15px; margin: 20px 0 6px; }
.muted { color: var(--muted); font-size: 13px; }

/* ----- app header ----- */
.app-header { position: sticky; top: 0; z-index: 30; background: var(--header-bg); color: var(--header-ink); border-bottom: 1px solid var(--border); }
.app-header .bar { max-width: var(--page-max); margin: 0 auto; display: flex; align-items: center; gap: 16px; padding: 11px 28px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 750; font-size: 16px; letter-spacing: -.02em; color: var(--header-ink); text-decoration: none; }
.brand .mark { display: grid; place-items: center; font-size: 17px; line-height: 1; }
.app-header .spacer { flex: 1; }
.seg { display: inline-flex; background: var(--seg-track); border-radius: 11px; padding: 3px; gap: 2px; }
.seg a { font: inherit; font-size: 13px; font-weight: 600; color: var(--seg-ink); text-decoration: none; border-radius: 8px; padding: 7px 15px; display: inline-flex; align-items: center; gap: 7px; }
.seg a.active { background: var(--seg-active-bg); color: var(--seg-active-ink); box-shadow: 0 1px 2px rgba(0,0,0,.13); }
.seg .count { font-size: 11px; font-weight: 730; padding: 1px 7px; border-radius: 999px; background: rgba(125,125,125,.2); }
.hsearch { display: flex; align-items: center; background: var(--seg-track); border: 0; border-radius: 10px; padding: 0 12px; height: 34px; min-width: 160px; }
.hsearch input { border: 0; background: transparent; outline: none; color: var(--header-ink); font: inherit; font-size: 13px; width: 100%; }
.hsearch input::placeholder { color: var(--seg-ink); }
.icon-btn { width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; font-size: 14px; display: inline-grid; place-items: center; }
.icon-btn:hover { color: var(--ink); background: var(--row-hover); }
.icon-btn.icon-danger:hover { color: var(--danger); border-color: var(--danger); }
.app-header .icon-btn { background: var(--seg-track); color: var(--header-ink); border: 0; }
.app-header .icon-btn:hover { background: rgba(125,125,125,.18); }

/* ----- overflow menu ----- */
.menu { position: relative; display: inline-block; }
.menu-pop { display: none; position: absolute; right: 0; top: calc(100% + 6px); background: var(--surface); border: 1px solid var(--border); border-radius: 11px; box-shadow: var(--shadow); padding: 6px; min-width: 196px; z-index: 70; }
.menu-pop.open { display: block; }
.menu-pop button, .menu-pop a { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; background: none; border: 0; border-radius: 8px; padding: 8px 11px; font: inherit; font-size: 13px; color: var(--ink); cursor: pointer; text-decoration: none; }
.menu-pop button:hover, .menu-pop a:hover { background: var(--row-hover); }
.menu-pop .sep { height: 1px; background: var(--hairline); margin: 5px 4px; }
.menu-pop .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: 7px 11px 3px; }
.menu-pop .danger { color: var(--danger); }

/* ----- toolbar / fields / buttons ----- */
.toolbar { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 16px; gap: 20px; flex-wrap: wrap; }
.toolbar h1 { margin: 0; }
.toolbar .sub { color: var(--muted); font-size: 13px; margin-top: 5px; max-width: 560px; }
.tools { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.field { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0 12px; height: 38px; min-width: 220px; }
.field input { border: 0; background: transparent; outline: none; color: var(--ink); font: inherit; font-size: 13px; flex: 1; }
.field input::placeholder { color: var(--muted); }
.field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.btn { font: inherit; font-size: 13px; font-weight: 600; border-radius: 10px; padding: 8px 14px; cursor: pointer; border: 1px solid transparent; line-height: 1.1; }
.btn-primary { background: var(--accent); color: var(--accent-ink); }
.btn-primary:hover { opacity: .92; }
.btn-ghost { background: var(--surface); color: var(--ink); border-color: var(--border); }
.btn-ghost:hover { background: var(--row-hover); }

/* ----- stat strip ----- */
.stats-row { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }

/* ----- inbox list ----- */
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); overflow: hidden; }
.lead { display: flex; align-items: center; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--hairline); }
.lead:last-child { border-bottom: 0; }
.lead:hover { background: var(--row-hover); }
.lead[data-url] { cursor: pointer; }
.lead.is-hidden { display: none; }
.lead-main { flex: 1 1 auto; min-width: 0; }
.lead-co { font-weight: 680; font-size: 14.5px; letter-spacing: -.01em; }
.lead-role { color: var(--muted); font-size: 13px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lead-meta { display: flex; gap: 14px; margin-top: 6px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.lead-meta span { white-space: nowrap; }
.lead-act { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }

/* ----- filter bar (reuses col-filter/col-dropdown JS) ----- */
/* Same 16px rhythm as .stats-row above it — the "N of M shown" summary now
   lives inside this bar rather than in a spacer row underneath it. */
.filter-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; flex-wrap: wrap; }
.filter-bar #inbox-summary { font-size: 12.5px; margin-left: 4px; }
.filter-bar #inbox-summary:empty { display: none; }
.col-filter { position: relative; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; font-size: 12.5px; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 7px 13px; }
.col-filter:hover { border-color: var(--accent); }
.col-filter.filtered { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.col-dropdown { display: none; position: absolute; top: calc(100% + 6px); left: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 11px; box-shadow: var(--shadow); padding: 6px; min-width: 184px; z-index: 50; max-height: 340px; overflow-y: auto; }
.col-dropdown.open { display: block; }
.col-dropdown-loc { min-width: 200px; }
.col-dropdown label { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; font-size: 12.5px; border-radius: 8px; color: var(--ink); white-space: nowrap; }
.col-dropdown label:hover { background: var(--row-hover); }
.col-dropdown label.opt-disabled { opacity: .35; }
.col-dropdown input[type=checkbox] { width: 14px; height: 14px; cursor: pointer; flex-shrink: 0; accent-color: var(--accent); }
.opt-count { color: var(--muted); font-size: 11px; margin-left: auto; }
.col-dropdown-clear { display: block; width: 100%; text-align: left; padding: 7px 10px; font-size: 12px; color: var(--accent); cursor: pointer; background: none; border: 0; border-bottom: 1px solid var(--hairline); margin-bottom: 4px; border-radius: 0; }
.col-dropdown-clear:hover { background: var(--row-hover); }
.sortctl { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-left: auto; }
.sortctl select { font: inherit; font-size: 12.5px; border: 1px solid var(--border); border-radius: 999px; padding: 7px 11px; background: var(--surface); color: var(--ink); cursor: pointer; }
.chip-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-weight: 600; font-size: 12.5px; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 7px 13px; font-family: inherit; }
.chip-toggle:hover { border-color: var(--accent); }
.chip-toggle.active { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.chip-toggle .chip-count { font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 999px; background: rgba(125,125,125,.2); }
.chip-toggle.active .chip-count { background: rgba(255,255,255,.25); }
.new-badge { display: inline-block; vertical-align: middle; margin-left: 7px; font-size: 9.5px; font-weight: 800; letter-spacing: .06em; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); }
.lead.is-new { box-shadow: inset 3px 0 0 var(--accent); }
.kc.is-new { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }

/* ----- pipeline board ----- */
.board { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; align-items: start; }
@media (max-width: 1100px) { .board { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 680px) { .board { grid-template-columns: 1fr; } }
/* Rejected: collapsible leftmost rail. Header matches other columns; when
   collapsed, a stacked-card "peek" below hints there's hidden content. */
.col-rejected { position: relative; }
.col-rejected.collapsed { min-height: 0; }
.col-rejected.collapsed .col-body { display: none; }
.col-h-toggle { cursor: pointer; user-select: none; }
.col-h-toggle .chev { display: inline-block; transition: transform .15s ease; margin-right: 7px; font-size: 11px; color: var(--muted); }
.col-rejected:not(.collapsed) .col-h-toggle .chev { transform: rotate(90deg); }
.rej-peek { display: none; }
.col-rejected.collapsed .rej-peek { display: block; cursor: pointer; padding-bottom: 6px; }
.rej-peek-ghost { height: 30px; border: 1px solid var(--border); border-radius: 10px; background: var(--canvas); position: relative; transition: transform .2s ease; }
.rej-peek-ghost::before, .rej-peek-ghost::after { content: ''; position: absolute; left: 8px; right: 8px; border: 1px solid var(--border); border-top: none; border-radius: 0 0 9px 9px; background: var(--canvas); height: 6px; transition: bottom .2s ease; }
.rej-peek-ghost::before { bottom: -5px; }
.rej-peek-ghost::after { bottom: -9px; left: 13px; right: 13px; opacity: .55; }
.rej-peek-cap { margin-top: 15px; text-align: center; font-size: 11px; color: var(--muted); transition: opacity .18s ease; }
/* playful fan-out of the stacked cards on hover */
.col-rejected.collapsed:hover .rej-peek-ghost { transform: translateY(-2px); }
.col-rejected.collapsed:hover .rej-peek-ghost::before { bottom: -7px; }
.col-rejected.collapsed:hover .rej-peek-ghost::after { bottom: -13px; }
.col-rejected.collapsed:hover .rej-peek-cap { opacity: .5; }
/* floating preview that fades + slides in on hover — no board reflow */
.rej-preview { display: none; }
.col-rejected.collapsed .rej-preview { display: block; position: absolute; left: 8px; right: 8px; top: 44px; z-index: 40; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 10px 28px rgba(0,0,0,.15); padding: 6px; opacity: 0; transform: translateY(-6px) scale(.98); transform-origin: top left; pointer-events: none; transition: opacity .18s ease, transform .22s cubic-bezier(.2,.7,.3,1); }
.col-rejected.collapsed:hover .rej-preview { opacity: 1; transform: translateY(0) scale(1); }
.rej-pv-row { display: flex; align-items: center; gap: 8px; padding: 7px 6px; opacity: 0; transform: translateX(-4px); transition: opacity .2s ease, transform .2s ease; }
.rej-pv-row + .rej-pv-row { border-top: 1px solid var(--border); }
.col-rejected.collapsed:hover .rej-pv-row { opacity: 1; transform: translateX(0); }
.col-rejected.collapsed:hover .rej-pv-row:nth-child(2) { transition-delay: .04s; }
.col-rejected.collapsed:hover .rej-pv-row:nth-child(3) { transition-delay: .08s; }
.col-rejected.collapsed:hover .rej-pv-row:nth-child(4) { transition-delay: .12s; }
.rej-pv-txt { font-size: 12px; color: var(--fg); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.rej-pv-txt b { font-weight: 680; }
.rej-pv-more { text-align: center; font-size: 10.5px; color: var(--muted); padding: 5px 0 2px; }
/* Subsections inside the Rejected rail: interviewed-then-rejected sits on top,
   marked warm, because those companies met him and can be re-approached. */
.rej-sec + .rej-sec { margin-top: 12px; }
.rej-sec.drop-target { outline: 2px dashed var(--accent); outline-offset: 3px; border-radius: 10px; background: var(--accent-weak); }
.rej-sec-h { display: flex; align-items: center; gap: 7px; font-size: 10.5px; font-weight: 720; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); padding: 0 2px 7px; cursor: pointer; user-select: none; }
.rej-sec-h::after { content: ''; order: 2; flex: 1; height: 1px; background: var(--border); }
.rej-sec-c { order: 3; font-weight: 730; font-size: 10px; color: var(--muted); background: var(--neutral-bg); border-radius: 999px; padding: 1px 7px; }
.rej-sec-warm { color: #B4534B; }
.rej-sec-warm::after { background: rgba(180, 83, 75, .28); }
.sec-chev { font-size: 9px; line-height: 1; transition: transform .16s ease; }
.rej-sec.sec-collapsed .sec-chev { transform: rotate(-90deg); }
.rej-sec.sec-collapsed .rej-sec-body { display: none; }
.rej-sec.sec-collapsed .rej-sec-h { padding-bottom: 2px; }
.col { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 11px; min-height: 180px; }
.col.drop-target { outline: 2px dashed var(--accent); outline-offset: -4px; background: var(--accent-weak); }
.closed-lane.drop-target { outline: 2px dashed var(--accent); outline-offset: 2px; border-radius: 10px; background: var(--accent-weak); }
.col-h { display: flex; align-items: center; justify-content: space-between; padding: 5px 6px 12px; font-size: 12.5px; font-weight: 720; letter-spacing: -.01em; }
.col-h .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; vertical-align: middle; }
.col-h .c { font-weight: 730; color: var(--muted); font-size: 11px; background: var(--neutral-bg); border-radius: 999px; padding: 2px 8px; }
.kc { background: var(--canvas); border: 1px solid var(--border); border-radius: 11px; padding: 11px 12px; margin-bottom: 9px; }
.kc:hover { border-color: var(--accent); }
.kc.dragging { opacity: .45; }
.kc[draggable] { cursor: grab; }
.kc[draggable]:active { cursor: grabbing; }
.kc[data-url] { cursor: pointer; }
.kc .kc-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.kc .co { font-weight: 680; font-size: 14px; letter-spacing: -.01em; }
.kc .ro { color: var(--muted); font-size: 12px; margin-top: 2px; }
.kc .foot { display: flex; align-items: center; gap: 9px; margin-top: 11px; flex-wrap: wrap; }
.kc .kbtns { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.kmeta { font-size: 11px; color: var(--muted); }
.kc-empty { color: var(--muted); font-size: 12px; text-align: center; padding: 22px 8px; border: 1px dashed var(--border); border-radius: 11px; }
.kc.closed { opacity: .6; }
.closed-lane { margin-top: 18px; }
.closed-lane > summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600; padding: 8px 0; list-style: none; }
.closed-lane > summary::-webkit-details-marker { display: none; }
.closed-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 9px; margin-top: 8px; }

/* ----- score / verdict pills + chips ----- */
.score-pill { display: inline-flex; align-items: center; justify-content: center; padding: 2px 9px; border-radius: 999px; font-weight: 680; font-size: 12px; white-space: nowrap; }
.score-chip { width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center; font-weight: 730; font-size: 15px; flex: 0 0 auto; }
.score-mini { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 7px; font-weight: 730; font-size: 11.5px; }
.score-high { background: var(--good-bg); color: var(--good-ink); }
.score-mid  { background: var(--mid-bg);  color: var(--mid-ink); }
.score-low  { background: var(--warn-bg); color: var(--warn-ink); }
.score-skip { background: var(--neutral-bg); color: var(--neutral-ink); }
.verdict-pill { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-weight: 700; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
/* Flat status flag (not a button): only shown for SUSPICIOUS/unverified leads. */
.lead-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--warn-ink); background: var(--warn-bg); padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
.verdict-high  { background: var(--accent); color: var(--accent-ink); }
.verdict-apply { background: var(--good-bg); color: var(--good-ink); }
.verdict-skip  { background: var(--neutral-bg); color: var(--neutral-ink); }
.verdict-warn  { background: var(--warn-bg); color: var(--warn-ink); }
.verdict-other { background: var(--mid-bg); color: var(--mid-ink); }

/* ----- buttons used in row/card markup ----- */
.btn-apply { background: var(--accent); color: var(--accent-ink); border: 0; padding: 7px 13px; border-radius: 9px; font-size: 12.5px; cursor: pointer; font-weight: 600; font-family: inherit; }
.btn-apply:hover { opacity: .92; }
.btn-apply:disabled { opacity: .6; }
.btn-shortlist { background: var(--accent-weak); color: var(--accent); border: 1px solid transparent; padding: 7px 13px; border-radius: 9px; font-size: 12.5px; cursor: pointer; font-weight: 600; font-family: inherit; }
.btn-shortlist:hover { filter: brightness(.97); }
.btn-shortlist:disabled { opacity: .7; cursor: default; }
.btn-delete { background: transparent; color: var(--muted); border: 1px solid var(--border); padding: 6px 9px; border-radius: 9px; font-size: 13px; cursor: pointer; font-family: inherit; }
.btn-delete:hover { color: var(--ink); background: var(--row-hover); }
.btn-report { display: inline-flex; align-items: center; padding: 6px 11px; border-radius: 9px; font-size: 12.5px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); text-decoration: none; font-weight: 600; }
.btn-report:hover { background: var(--row-hover); }
.pack-link { color: var(--accent); font-size: 12.5px; text-decoration: none; font-weight: 600; }
.pack-link:hover { text-decoration: underline; }
.btn-add-toggle { display: inline-flex; align-items: center; padding: 7px 13px; border: 1px dashed var(--border); border-radius: 999px; text-decoration: none; font-size: 12.5px; font-weight: 600; color: var(--accent); background: var(--surface); cursor: pointer; }
.btn-add-toggle:hover { border-color: var(--accent); }
/* Scoring-rules disclosure. Deliberately NOT a dashed pill — dashed pills read
   as "add a new thing" (see .btn-add-toggle). This expands a panel, so it is a
   plain secondary button with a caret that flips while the panel is open. */
.btn-rules { display: inline-flex; align-items: center; gap: 8px; font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1.2; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 9px 14px; cursor: pointer; }
.btn-rules:hover { background: var(--row-hover); border-color: var(--muted); }
.btn-rules .caret { font-size: 10px; color: var(--muted); transition: transform .15s ease; }
.btn-rules.is-open { border-color: var(--accent); color: var(--accent); background: var(--accent-weak); }
.btn-rules.is-open .caret { transform: rotate(180deg); color: var(--accent); }
.add-form { display: none; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; margin: 0 0 16px; }
.add-form.open { display: block; }
.add-form .add-row { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.add-form input[type=url], .add-form input[type=text] { padding: 9px 12px; border: 1px solid var(--border); border-radius: 9px; font-size: 13.5px; font-family: inherit; background: var(--surface); color: var(--ink); }
.add-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
/* Two columns so Hard and Soft stack side by side — the panel's height is then
   the taller group, not the sum of both. Collapses to one column when narrow. */
.rules-panel { display: none; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin: 0 0 16px; }
.rules-panel.open { display: block; }
/* Hard gets the wider column: its rules are long prose, Soft's are one-liners.
   An even split made the hard rules wrap enough to cancel out the saving. */
.rules-cols { display: grid; grid-template-columns: 1.7fr 1fr; gap: 8px 18px; align-items: start; }
@media (max-width: 900px) { .rules-cols { grid-template-columns: 1fr; } }
.rules-group-h { font-size: 13px; font-weight: 600; margin-bottom: 7px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.rules-group-h .rg-sub { font-weight: 400; color: var(--muted); font-size: 12px; }
.rg-badge { font-size: 10.5px; font-weight: 700; letter-spacing: .02em; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; }
.rg-badge.hard { background: rgba(180,65,60,.13); color: #b4413c; }
.rg-badge.soft { background: rgba(201,154,46,.18); color: #946f16; }
.rule-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: flex-start; }
.rule-row input, .rule-row textarea { flex: 1; padding: 7px 10px 7px 11px; border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; font-size: 13px; font-family: inherit; line-height: 1.45; background: var(--canvas); color: var(--ink); }
.rule-row textarea { resize: none; overflow: hidden; min-height: 33px; }
#guard-hard .rule-row textarea { border-left-color: #d08b86; }
#guard-soft .rule-row textarea { border-left-color: #d6b873; }
.rule-row input:focus, .rule-row textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.rule-del { flex: 0 0 auto; width: 30px; height: 33px; border: 1px solid var(--border); background: transparent; border-radius: 8px; cursor: pointer; color: var(--muted); font-size: 15px; line-height: 1; }
.rule-del:hover { border-color: #b4413c; color: #b4413c; }
.rules-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.btn-add-row { background: transparent; border: 1px dashed var(--border); border-radius: 8px; padding: 6px 11px; cursor: pointer; font-size: 12.5px; color: var(--muted); }
.btn-add-row:hover { border-color: var(--accent); color: var(--accent); }
.btn-save { background: var(--accent); color: #fff; border: none; border-radius: 9px; padding: 8px 18px; cursor: pointer; font-size: 13px; font-weight: 600; }
.btn-save:hover { opacity: .9; }
.btn-save:disabled { opacity: .5; cursor: default; }
.rules-actions .muted { font-size: 12.5px; }
.set-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; margin: 0 0 8px; }
.set-card h3 { margin: 0 0 12px; font-size: 15px; }
.set-row { display: flex; gap: 16px; padding: 7px 0; border-bottom: 1px solid var(--hairline); font-size: 13.5px; }
.set-row:last-of-type { border-bottom: none; }
.set-k { flex: 0 0 150px; color: var(--muted); }
.set-v { flex: 1; color: var(--ink); }
.btn-set { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; border-radius: 9px; padding: 8px 16px; font-size: 13px; font-weight: 600; }
.btn-set:hover { opacity: .9; }
.row-deleting { opacity: 0; transition: opacity 0.2s; }

/* ----- scan control (lives on the stats row, right-aligned) ----- */
.btn-batch { background: var(--accent); color: var(--accent-ink); border: 0; padding: 8px 16px; border-radius: 10px; font-size: 13px; cursor: pointer; font-weight: 600; font-family: inherit; transition: opacity .15s ease; }
.btn-batch:hover { opacity: .92; }
.btn-batch:disabled { opacity: .55; cursor: default; }
.row-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
/* Scoring rules now sits on the right of the row, so it carries the auto margin
   that used to push .row-actions over. */
.stats-row .btn-rules { margin-left: auto; }
/* Ambient figures that sit beside a control row, not chips you can click. */
.row-meta { font-size: 12.5px; color: var(--muted); margin-left: 4px; }
.row-meta b { color: var(--ink); font-weight: 730; }
.batch-banner { display: none; align-items: center; gap: 9px; font-size: 13px; color: var(--muted); }
.batch-banner.show { display: flex; }
.batch-banner .batch-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
.batch-banner .batch-icon:empty { display: none; }
.batch-banner .batch-msg { font-weight: 600; color: var(--ink); }
.batch-banner .batch-msg:empty { display: none; }
/* "Last search 4h ago" is ambient info, not a status alert — keep it quiet. */
.batch-banner .batch-msg.meta { font-weight: 500; color: var(--muted); }
.batch-banner .batch-elapsed { opacity: .65; }
.batch-banner a { color: var(--accent); font-weight: 700; text-decoration: underline; }
/* state reads from the status text now — no full-width coloured bar above the page */
.batch-banner.is-running .batch-msg { color: var(--mid-ink); }
.batch-banner.is-done    .batch-msg { color: var(--good-ink); }
.batch-banner.is-failed  .batch-msg { color: var(--warn-ink); }

/* ----- markdown / report ----- */
.report-body { background: var(--surface); padding: 28px 32px; border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); }
.report-body h1, .report-body h2, .report-body h3 { letter-spacing: -.01em; }
.empty { color: var(--muted); font-style: italic; padding: 24px; text-align: center; }
code { background: var(--neutral-bg); padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; color: var(--ink); }
pre { background: #1F1D1B; color: #ECE7DF; padding: 12px 14px; border-radius: 10px; overflow-x: auto; font-size: 13px; }
pre code { background: transparent; color: inherit; padding: 0; }
blockquote { border-left: 3px solid var(--border); padding: 4px 14px; color: var(--muted); margin: 12px 0; }
hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; font-size: 13.5px; overflow: hidden; }
thead th { background: var(--canvas); border-bottom: 1px solid var(--border); padding: 10px 12px; text-align: left; font-weight: 700; color: var(--ink); }
tbody td { padding: 10px 12px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--row-hover); }
.md-table { font-size: 13.5px; }
.md-table th, .md-table td { padding: 8px 10px; border: 1px solid var(--border); }

/* ----- toast ----- */
.toast { position: fixed; bottom: 24px; right: 24px; background: var(--ink); color: var(--canvas); padding: 11px 17px; border-radius: 11px; font-size: 13px; font-weight: 500; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 200; box-shadow: var(--shadow); }
.toast.show { opacity: 1; }
.toast.error { background: var(--danger); color: #fff; }

/* ----- side panel ----- */
#panel-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); opacity: 0; pointer-events: none; transition: opacity 0.18s ease; z-index: 80; }
#panel-overlay.show { opacity: 1; pointer-events: auto; }
#panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(880px, 92vw); background: var(--surface); box-shadow: -4px 0 24px rgba(0,0,0,0.18); transform: translateX(100%); transition: transform 0.22s ease; z-index: 90; display: flex; flex-direction: column; }
#panel.show { transform: translateX(0); }
#panel-header { display: flex; align-items: center; justify-content: space-between; padding: 13px 18px; border-bottom: 1px solid var(--border); background: var(--canvas); flex-shrink: 0; }
#panel-title { font-weight: 700; font-size: 14px; color: var(--ink); }
#panel-close { background: transparent; border: 0; font-size: 22px; cursor: pointer; color: var(--muted); line-height: 1; padding: 4px 8px; border-radius: 8px; }
#panel-close:hover { background: var(--row-hover); color: var(--ink); }
#panel-body { padding: 24px 28px; overflow-y: auto; flex: 1; }
#panel-body .md-table { font-size: 13px; }
#panel-body .report-body { border: 0; box-shadow: none; padding: 0; background: transparent; }
`;

const PANEL_HTML = `
<div id="panel-overlay" onclick="closePanel()"></div>
<div id="panel" role="dialog" aria-hidden="true">
  <div id="panel-header">
    <span id="panel-title"></span>
    <button id="panel-close" onclick="closePanel()" title="Close (Esc)">&times;</button>
  </div>
  <div id="panel-body"></div>
</div>
`;

const TABLE_JS = `
<script>
// ----- Scoring guardrails editor (Inbox + Settings): hard vs soft -----
let guardrailsLoaded = false;
function toggleGuardrails() {
  const panel = document.getElementById('guardrails-panel');
  if (!panel) return;
  const open = panel.classList.toggle('open');
  const btn = document.getElementById('rules-toggle');
  if (btn) { btn.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); }
  if (open && !guardrailsLoaded) loadGuardrails();
}
async function loadGuardrails() {
  const hard = document.getElementById('guard-hard');
  const soft = document.getElementById('guard-soft');
  if (!hard || !soft) return;
  hard.innerHTML = soft.innerHTML = '<div class="muted" style="padding:6px 0">Loading…</div>';
  try {
    const d = await (await fetch('/api/guardrails')).json();
    hard.innerHTML = ''; soft.innerHTML = '';
    (d.hard || []).forEach(it => addRuleRow('hard', it, false));
    (d.soft || []).forEach(it => addRuleRow('soft', it, false));
    guardrailsLoaded = true;
  } catch (e) { hard.innerHTML = '<div class="muted" style="padding:6px 0">Could not load scoring rules.</div>'; }
}
function autoGrowRule(t) { t.style.height = 'auto'; t.style.height = Math.max(t.scrollHeight, 20) + 'px'; }
function addRuleRow(group, val, doFocus) {
  const list = document.getElementById('guard-' + group);
  if (!list) return;
  const row = document.createElement('div'); row.className = 'rule-row';
  const ta = document.createElement('textarea'); ta.rows = 1; ta.value = val || '';
  ta.placeholder = group === 'hard'
    ? 'e.g. Crypto / web3, a company, or a level to skip entirely'
    : 'e.g. requires far more experience than my CV, or on-site far from me';
  ta.addEventListener('input', () => autoGrowRule(ta));
  const del = document.createElement('button'); del.type = 'button'; del.className = 'rule-del'; del.textContent = '×'; del.title = 'Remove';
  del.onclick = () => row.remove();
  row.appendChild(ta); row.appendChild(del); list.appendChild(row);
  autoGrowRule(ta);
  if (doFocus) ta.focus();
}
async function saveGuardrails(btn) {
  const collect = g => Array.from(document.querySelectorAll('#guard-' + g + ' textarea')).map(t => t.value.trim()).filter(Boolean);
  const hard = collect('hard'), soft = collect('soft');
  const msg = document.getElementById('guardrails-msg');
  btn.disabled = true; if (msg) { msg.style.color = 'var(--muted)'; msg.textContent = 'Saving…'; }
  try {
    const d = await (await fetch('/api/guardrails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hard, soft }) })).json();
    if (!d.ok) { if (msg) { msg.style.color = '#b4413c'; msg.textContent = 'Save failed: ' + (d.error || 'unknown'); } return; }
    if (msg) { msg.style.color = '#3A6B45'; msg.textContent = 'Saved — ' + d.hard + ' hard, ' + d.soft + ' soft. Applies on the next scoring run.'; }
  } catch (e) { if (msg) { msg.style.color = '#b4413c'; msg.textContent = 'Save failed: ' + e.message; } }
  finally { btn.disabled = false; }
}
function showToast(msg, isError) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.classList.toggle('error', !!isError);
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._hideT);
  t._hideT = setTimeout(() => t.classList.remove('show'), 2800);
}
function applyJob(url, btn) {
  if (!url) { showToast('No URL on this row', true); return; }
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '...';
  fetch('/api/apply', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({url})
  }).then(r => r.json()).then(j => {
    if (j.ok) { btn.textContent = '✓ Opened'; showToast('Terminal opened — claude is loading'); }
    else { btn.textContent = orig; btn.disabled = false; showToast('Apply failed: ' + (j.error||'unknown'), true); }
    setTimeout(() => { if (btn.textContent === '✓ Opened') { btn.textContent = orig; btn.disabled = false; } }, 3000);
  }).catch(e => { btn.textContent = orig; btn.disabled = false; showToast('Apply failed: ' + e.message, true); });
}
function setStatus(sel) {
  const num = sel.dataset.num;
  const status = sel.value;
  const prev = sel.dataset.status || 'Evaluated';
  if (status === prev) return;
  sel.disabled = true;
  fetch('/api/set-status', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({num, status})
  }).then(r => r.json()).then(j => {
    sel.disabled = false;
    if (!j.ok) { sel.value = prev; showToast('Status update failed: ' + (j.error||'unknown'), true); return; }
    sel.dataset.status = status;
    const row = sel.closest('tr');
    const statusCell = row && row.querySelector('[data-cell=status]');
    if (statusCell) statusCell.textContent = status;
    if (row) {
      row.classList.remove('row-applied', 'row-rejected', 'row-discarded');
      if (status === 'Applied')        row.classList.add('row-applied');
      else if (status === 'Rejected')  row.classList.add('row-rejected');
      else if (status === 'Discarded') row.classList.add('row-discarded');
    }
    showToast('Status: ' + status);
  }).catch(e => { sel.disabled = false; sel.value = prev; showToast(e.message, true); });
}
function dismissTriage(url, btn) {
  if (!url) return;
  if (!confirm('Remove this posting from triage?\\n\\nA backup of triage-scores.tsv will be saved at triage-scores.tsv.bak. Use this for postings that do not fit or that you have already reviewed.')) return;
  btn.disabled = true;
  fetch('/api/triage-dismiss', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({url})
  }).then(r => r.json()).then(j => {
    if (!j.ok) { btn.disabled = false; showToast('Dismiss failed: ' + (j.error||'unknown'), true); return; }
    const row = btn.closest('.lead, .kc, tr');
    if (row) { row.classList.add('row-deleting'); setTimeout(() => row.remove(), 220); }
    showToast('Removed from triage');
  }).catch(e => { btn.disabled = false; showToast(e.message, true); });
}
function shortlistJob(payload, btn) {
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '...';
  fetch('/api/shortlist', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(j => {
    if (j.ok && j.noChange) { btn.textContent = '✓ Already in tracker'; showToast('Already in tracker'); }
    else if (j.ok) { btn.textContent = '✓ Shortlisted #' + j.num; showToast('Added to tracker (#' + j.num + ', Shortlisted)'); }
    else { btn.textContent = orig; btn.disabled = false; showToast('Shortlist failed: ' + (j.error||'unknown'), true); return; }
    // Remove the row from the triage table — it lives in the tracker now.
    const row = btn.closest('.lead, .kc, tr');
    if (row) { row.classList.add('row-deleting'); setTimeout(() => row.remove(), 300); }
  }).catch(e => { btn.textContent = orig; btn.disabled = false; showToast(e.message, true); });
}
function deleteRow(num, btn) {
  if (!num) return;
  if (!confirm('Delete row #' + num + '?\\n\\nA backup of applications.md will be saved at applications.md.bak. This cannot be undone from the UI.')) return;
  btn.disabled = true;
  fetch('/api/delete-row', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({num})
  }).then(r => r.json()).then(j => {
    if (!j.ok) { btn.disabled = false; showToast('Delete failed: ' + (j.error||'unknown'), true); return; }
    const row = btn.closest('.lead, .kc, tr');
    if (row) {
      row.classList.add('row-deleting');
      setTimeout(() => row.remove(), 220);
    }
    showToast('Deleted row #' + num);
  }).catch(e => { btn.disabled = false; showToast(e.message, true); });
}
function openPanel(file, title) {
  const panel = document.getElementById('panel');
  const overlay = document.getElementById('panel-overlay');
  const body = document.getElementById('panel-body');
  document.getElementById('panel-title').textContent = title || file;
  body.innerHTML = '<p class="muted">Loading…</p>';
  panel.classList.add('show'); overlay.classList.add('show');
  panel.setAttribute('aria-hidden', 'false');
  fetch('/api/report?file=' + encodeURIComponent(file))
    .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(html => { body.innerHTML = html; body.scrollTop = 0; })
    .catch(e => { body.innerHTML = '<p class="muted">Failed to load: ' + e.message + '</p>'; });
}
function closePanel() {
  document.getElementById('panel').classList.remove('show');
  document.getElementById('panel-overlay').classList.remove('show');
  document.getElementById('panel').setAttribute('aria-hidden', 'true');
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'warm-dark' ? 'warm' : 'warm-dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('gtj-theme', next); } catch (e) {}
}
function quitServer() {
  if (!confirm('Shut down the GetTheJob server?')) return;
  fetch('/api/quit', { method: 'POST' }).then(() => {
    document.body.innerHTML = '<div style="text-align:center;padding:90px 20px;font-size:17px;color:var(--muted)">Server stopped. You can close this tab.</div>';
  }).catch(() => {});
}
function closeMenus(except) {
  document.querySelectorAll('.menu-pop.open').forEach(m => { if (m !== except) m.classList.remove('open'); });
}
function toggleMenu(e, btn) {
  e.stopPropagation();
  const pop = btn.parentNode.querySelector('.menu-pop');
  const willOpen = !pop.classList.contains('open');
  closeMenus(pop);
  pop.classList.toggle('open', willOpen);
}
function relTime(s) {
  const t = Date.parse(s);
  if (isNaN(t)) return s;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + 'd ago';
  const mo = Math.floor(days / 30);
  return mo === 1 ? '1mo ago' : mo + 'mo ago';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeMenus(null); if (document.getElementById('panel').classList.contains('show')) closePanel(); }
});
document.addEventListener('DOMContentLoaded', () => {
  // sortable column headers
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', (e) => {
      if (th.querySelector('.col-filter') && !e.target.closest('.col-sort')) return;
      const table = th.closest('table');
      const tbody = table.querySelector('tbody');
      const idx = Array.from(th.parentNode.children).indexOf(th);
      const type = th.dataset.sort || 'str';
      const cur = th.classList.contains('sort-asc') ? 'asc' : (th.classList.contains('sort-desc') ? 'desc' : '');
      const dir = cur === 'desc' ? 'asc' : 'desc';
      table.querySelectorAll('th.sortable').forEach(o => {
        o.classList.remove('sort-asc','sort-desc');
        const si = o.querySelector('.col-sort');
        if (si) si.textContent = '⇅';
      });
      th.classList.add('sort-' + dir);
      const sortIcon = th.querySelector('.col-sort');
      if (sortIcon) sortIcon.textContent = dir === 'asc' ? '↑' : '↓';
      const rows = Array.from(tbody.querySelectorAll('tr')).filter(r => !r.querySelector('.empty'));
      const factor = dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const ac = a.children[idx], bc = b.children[idx];
        if (!ac || !bc) return 0;
        const av = ac.dataset.sortKey || ac.textContent.trim();
        const bv = bc.dataset.sortKey || bc.textContent.trim();
        if (type === 'num') return ((parseFloat(av) || 0) - (parseFloat(bv) || 0)) * factor;
        if (type === 'date') return ((new Date(av).getTime() || 0) - (new Date(bv).getTime() || 0)) * factor;
        return av.localeCompare(bv, undefined, {sensitivity:'base'}) * factor;
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
  // intercept report links → open in side panel
  document.querySelectorAll('a[data-report-file]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      closeMenus(null);
      openPanel(a.dataset.reportFile, a.dataset.reportTitle || a.textContent);
    });
  });
  // relative dates ("6d ago")
  document.querySelectorAll('[data-rel]').forEach(el => { el.textContent = relTime(el.dataset.rel); });
  // close overflow menus on any outside click
  document.addEventListener('click', () => closeMenus(null));
});
</script>
`;

function shell(title, bodyHtml, nav = {}) {
  const { view = '', inbox = null, pipeline = null, wide = false } = nav;
  const seg = (href, key, label, count) =>
    `<a href="${href}" class="${view === key ? 'active' : ''}">${label}${count != null ? ` <span class="count">${count}</span>` : ''}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GetTheJob — ${escapeHtml(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💼</text></svg>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){try{var t=localStorage.getItem('gtj-theme');if(t!=='warm-dark'&&t!=='warm'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'warm-dark':'warm';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','warm');}})();</script>
<style>${CSS}</style>
</head>
<body>
<header class="app-header">
  <div class="bar">
    <a class="brand" href="/?view=inbox"><span class="mark">💼</span> Get The Job</a>
    <nav class="seg">
      ${seg('/?view=inbox', 'inbox', 'Inbox', inbox)}
      ${seg('/?view=pipeline', 'pipeline', 'Pipeline', pipeline)}
    </nav>
    <div class="spacer"></div>
    <div class="hsearch"><input id="global-search" type="search" placeholder="Search…" autocomplete="off" spellcheck="false"></div>
    <button class="icon-btn" id="theme-toggle" title="Toggle dark mode" onclick="toggleTheme()">◐</button>
    <div class="menu">
      <button class="icon-btn" title="More" aria-label="More" onclick="toggleMenu(event, this)">⋯</button>
      <div class="menu-pop">
        <a href="/settings">⚙&nbsp; Settings</a>
        <div class="sep"></div>
        <button class="danger" onclick="quitServer()">⎋&nbsp; Quit GetTheJob</button>
      </div>
    </div>
  </div>
</header>
<main class="container${wide ? ' wide' : ''}">
${bodyHtml}
</main>
${PANEL_HTML}
${TABLE_JS}
</body>
</html>`;
}

// ----- onboarding -----

function renderOnboarding(previewMode = false) {
  const demoAppPath = join(ROOT, 'examples', 'demo', 'applications.md');
  const demoTriagePath = join(ROOT, 'examples', 'demo', 'triage-scores.tsv');
  const demoAppExists = existsSync(demoAppPath);
  const demoTriageExists = existsSync(demoTriagePath);

  // Both previews mirror the real redesigned dashboard (Kanban board + lead list)
  // so the welcome-screen peek matches what users actually get.
  let previewTrackerHtml = '<div class="empty">Demo data not found.</div>';
  if (demoAppExists) {
    const { header, rows } = parseApplicationsMd(readFileSync(demoAppPath, 'utf8'));
    const idx = {
      date: header.findIndex(h => /^date$/i.test(h)),
      company: header.findIndex(h => /^company$/i.test(h)),
      role: header.findIndex(h => /^role$/i.test(h)),
      score: header.findIndex(h => /^score$/i.test(h)),
      status: header.findIndex(h => /^status$/i.test(h)),
    };
    const COLS = [
      { key: 'Rejected',    dot: '#B4534B',       statuses: ['Rejected'] },
      { key: 'Shortlisted', dot: '#C99A2E',       statuses: ['Shortlisted', 'Evaluated'] },
      { key: 'Applied',     dot: 'var(--accent)', statuses: ['Applied', 'Responded'] },
      { key: 'Interview',   dot: '#8B5CF6',       statuses: ['Interview'] },
      { key: 'Offer',       dot: '#3A6B45',       statuses: ['Offer'] },
    ];
    const CLOSED = ['Discarded', 'SKIP'];
    const miniCard = (r) => {
      const scoreRaw = r[idx.score] || '';
      return `<div class="kc">
        <div class="kc-top"><div><div class="co">${escapeHtml(r[idx.company] || '')}</div><div class="ro">${escapeHtml(r[idx.role] || '')}</div></div></div>
        <div class="foot"><span class="score-mini ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw || '—')}</span><span class="kmeta">${escapeHtml(r[idx.date] || '')}</span></div>
      </div>`;
    };
    const columnsHtml = COLS.map(c => {
      const cards = rows.filter(r => c.statuses.includes((r[idx.status] || '').trim()));
      const inner = cards.length ? cards.map(miniCard).join('') : `<div class="kc-empty">${c.key === 'Offer' ? 'Your next milestone' : 'Nothing here yet'}</div>`;
      return `<div class="col"><div class="col-h"><span><span class="dot" style="background:${c.dot}"></span>${c.key}</span><span class="c">${cards.length}</span></div>${inner}</div>`;
    }).join('');
    const closedCards = rows.filter(r => CLOSED.includes((r[idx.status] || '').trim()));
    const closedHtml = closedCards.length
      ? `<details class="closed-lane"><summary>Closed — ${closedCards.length} (discarded / skipped)</summary><div class="closed-grid">${closedCards.map(miniCard).join('')}</div></details>`
      : '';
    previewTrackerHtml = `<div style="padding:12px"><div class="board">${columnsHtml}</div>${closedHtml}</div>`;
  }

  let previewTriageHtml = '<div class="empty">Demo data not found.</div>';
  if (demoTriageExists) {
    const { header, rows } = parseTsv(readFileSync(demoTriagePath, 'utf8'));
    const idx = {
      score: header.findIndex(h => /^score$/i.test(h)),
      verdict: header.findIndex(h => /^verdict$/i.test(h)),
      company: header.findIndex(h => /^company$/i.test(h)),
      role: header.findIndex(h => /^role$/i.test(h)),
      location: header.findIndex(h => /^location$/i.test(h)),
      note: header.findIndex(h => /^one[_ ]line[_ ]note$/i.test(h)),
    };
    const sorted = rows.slice().sort((a, b) => parseFloat(b[idx.score]) - parseFloat(a[idx.score])).slice(0, 6);
    const leads = sorted.map(r => {
      const v = (r[idx.verdict] || '').trim();
      const scoreRaw = r[idx.score] || '';
      const meta = [r[idx.location], r[idx.note]].filter(Boolean).map(x => `<span>${escapeHtml(x)}</span>`).join('');
      return `<div class="lead">
        <div class="score-chip ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw || '—')}</div>
        <div class="lead-main">
          <div class="lead-co">${escapeHtml(r[idx.company] || '')}</div>
          <div class="lead-role">${escapeHtml(r[idx.role] || '')}</div>
          <div class="lead-meta">${meta}</div>
        </div>
        ${/^SUSPICIOUS/i.test(v) ? `<span class="lead-flag" title="Posting legitimacy unverified">⚠ unverified</span>` : ''}
        <div class="lead-act"><button class="btn-shortlist">→ Pipeline</button></div>
      </div>`;
    }).join('');
    previewTriageHtml = `<div class="lead-list">${leads}</div>`;
  }

  // Re-running setup prefills from the files on disk. The preview is a demo of a
  // fresh install, so it deliberately gets nothing.
  const prefillJson = jsonForScript(previewMode ? null : readExistingSetup());
  const industriesJson = JSON.stringify(INDUSTRIES);
  const roleSuggestionsJson = JSON.stringify(ROLE_SUGGESTIONS);
  const companyCatalogJson = JSON.stringify(COMPANY_CATALOG);
  const roleAliasesJson = JSON.stringify(ROLE_ALIASES);
  const starterCompaniesJson = JSON.stringify(STARTER_COMPANIES);
  const jobTypesJson = JSON.stringify(JOB_TYPES);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${PRODUCT_NAME} — Setup</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💼</text></svg>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){try{var t=localStorage.getItem('gtj-theme');if(t!=='warm-dark'&&t!=='warm'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'warm-dark':'warm';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','warm');}})();</script>
<style>
${CSS}
/* Every step starts at the same y: the progress bar is fixed at top:26px, so a
   single top padding here keeps headings from jumping between screens. */
.onboarding { max-width: 820px; margin: 0 auto; padding: 34px 32px 64px; box-sizing: border-box; }
.ob-step { display: none; width: 100%; }
.ob-step.active { display: block; animation: obStepIn .24s ease both; }
/* Opacity-only (no transform): a transform here would make the fixed progress
   bar resolve against this step instead of the viewport. */
@keyframes obStepIn { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .ob-step.active { animation: none; } }
.ob-hero { text-align: center; margin-bottom: 18px; }
.ob-hero h1 { font-size: 26px; margin: 0 0 4px; }
.ob-hero .ob-icon { font-size: 30px; margin-bottom: 2px; }
.ob-hero p { color: var(--muted); font-size: 14px; margin: 0; }
/* In normal flow, not fixed: a fixed bar floats over the content of a scrollable
   step and pins every step's heading to a different offset. */
.ob-progress { display: flex; justify-content: center; gap: 8px; margin: 0 0 22px; }
.ob-progress .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); transition: background 0.2s; }
.ob-progress .dot.done { background: var(--high); }
.ob-progress .dot.current { background: var(--accent); }
.ob-btn { display: inline-block; padding: 10px 28px; border-radius: 8px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.15s, opacity 0.15s; }
/* --on-accent, not #fff: in dark mode the accent is a light green and white text
   on it is barely legible. */
.ob-btn-primary { background: var(--accent); color: var(--on-accent); }
.ob-btn-primary:hover { opacity: 0.9; }
.ob-btn-secondary { background: var(--surface); color: var(--fg); border: 1px solid var(--border); }
.ob-btn-secondary:hover { background: var(--row-alt); }
.ob-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ob-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 30px; }
.ob-actions .ob-spacer { flex: 1; }
.ob-cards { display: flex; gap: 12px; margin-bottom: 10px; }
.ob-card { flex: 1; text-align: center; padding: 13px 11px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.ob-card-ic { font-size: 20px; margin-bottom: 5px; }
.ob-card strong { font-size: 13.5px; }
.ob-card p { color: var(--muted); font-size: 12px; margin: 4px 0 0; line-height: 1.45; }
.ob-manual { display: block; text-align: center; margin-top: 16px; font-size: 13px; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.ob-manual:hover { color: var(--ink); }
.ob-field { margin-bottom: 18px; }
.ob-field label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.ob-field .ob-hint { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.ob-field input, .ob-field textarea, .ob-field select { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; font-family: inherit; background: var(--surface); color: var(--fg); }
.ob-field input:focus, .ob-field textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.ob-field textarea { min-height: 150px; font-family: inherit; font-size: 14px; line-height: 1.5; }
/* The CV field holds markdown, so monospace is intentional there only. */
#ob-cv { font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace; font-size: 13px; }
.ob-req { color: var(--danger); font-weight: 700; }
.ob-opt { font-weight: 400; color: var(--muted); }
.ob-err { color: var(--danger); font-size: 12.5px; margin-top: 5px; display: none; }
.ob-err.show { display: block; }
input.ob-invalid, textarea.ob-invalid { border-color: var(--danger) !important; box-shadow: 0 0 0 3px rgba(180,65,60,.12) !important; }
.ob-row { display: flex; gap: 16px; }
.ob-row > .ob-field { flex: 1; }
.ob-industry-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-top: 8px; }
.ob-industry-card { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 2px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--surface); transition: border-color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.12s; user-select: none; font-size: 14px; }
/* Hover must NOT look like selected. Both used to compute to the same accent
   border + accent-weak background, so every card under the cursor read as
   already chosen and only a 16px ✓ told the truth. Hover is now a neutral grey
   lift; selected is accent-tinted with an accent ring, an accent bold label and
   a filled ✓ badge. */
.ob-industry-card:hover:not(.selected) { border-color: var(--muted); background: var(--row-hover); transform: translateY(-1px); }
.ob-industry-card.selected { border-color: var(--accent); background: var(--accent-weak); box-shadow: 0 0 0 3px var(--accent-weak); color: var(--accent); font-weight: 600; }
.ob-industry-card.selected:hover { filter: brightness(0.97); }
.ob-industry-card .ob-ic-icon { font-size: 20px; font-weight: 400; }
.ob-industry-card .ob-ic-check { display: none; margin-left: auto; flex: none; width: 19px; height: 19px; border-radius: 999px; background: var(--accent); color: var(--on-accent); font-size: 11.5px; font-weight: 700; line-height: 1; align-items: center; justify-content: center; }
.ob-industry-card.selected .ob-ic-check { display: inline-flex; }
/* Two mutually exclusive cards side by side, reusing the industry card's selected
   state so a pick reads the same everywhere in the wizard. Wraps rather than
   squeezing: "Open to anything in my field" needs the width. */
.ob-choice-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.ob-choice-row > .ob-industry-card { flex: 1 1 220px; }
.ob-tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); min-height: 42px; cursor: text; }
.ob-tags:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.ob-tag { display: inline-flex; align-items: center; gap: 4px; background: var(--score-mid-bg); color: var(--accent); padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 500; max-width: 100%; min-width: 0; }
/* A chip has to survive whatever gets typed into it: no space to break on, 300
   characters long. It wraps inside its box (up to 3 lines) instead of escaping
   the card and dragging the page sideways. */
.ob-tag > span { min-width: 0; overflow-wrap: anywhere; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.ob-tag button { flex: 0 0 auto; background: none; border: none; cursor: pointer; color: var(--accent); font-size: 14px; padding: 0; line-height: 1; opacity: 0.6; }
.ob-tag button:hover { opacity: 1; }
.ob-tags input { border: none; outline: none; flex: 1; min-width: 120px; font-size: 14px; padding: 2px 4px; background: transparent; color: var(--fg); }
/* In flow, not absolutely positioned: the list opens on focus (so a career
   changer sees ideas without typing), and an overlay that size would sit on top
   of the Next button — a click meant for Next would silently add a role. */
.ob-suggestions { position: relative; margin-top: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; max-height: 220px; overflow-y: auto; display: none; }
.ob-suggestions.open { display: block; }
.ob-suggestions div { padding: 8px 12px; cursor: pointer; font-size: 13px; }
.ob-suggestions div:hover, .ob-suggestions div.highlighted { background: var(--row-alt); }
.ob-preview-tabs { display: flex; gap: 0; }
.ob-preview-tab { padding: 7px 18px; border: 1px solid var(--border); border-bottom: none; border-radius: 6px 6px 0 0; cursor: pointer; font-size: 13px; font-weight: 500; background: var(--row-alt); color: var(--muted); }
.ob-preview-tab.active { background: var(--surface); color: var(--fg); border-bottom-color: var(--surface); position: relative; z-index: 1; }
/* No max-height: the demo board renders whole. A clipped peek reads as a bug. */
.ob-preview-panel { border: 1px solid var(--border); border-radius: 0 6px 6px 6px; background: var(--canvas); padding: 0; position: relative; top: -1px; overflow: hidden; }
.ob-preview-panel .board { grid-template-columns: repeat(5, minmax(120px, 1fr)); }
.ob-preview-panel .col { min-height: 110px; }
.ob-preview-panel .lead-list { background: var(--surface); }
/* pointer-events:none — the overlay only blocks clicks on the fake rows, it must
   not swallow scrolling or selection. */
.ob-preview-panel .disabled-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 5; pointer-events: none; }
.ob-preview-wrap { position: relative; }
.ob-upload-zone { border: 2px dashed var(--border); border-radius: 8px; padding: 26px 20px; text-align: center; cursor: pointer; transition: border-color 0.15s, background 0.15s; margin-bottom: 14px; }
.ob-upload-zone:hover, .ob-upload-zone.dragover { border-color: var(--accent); background: var(--accent-weak); }
.ob-upload-zone .ob-upload-icon { font-size: 30px; margin-bottom: 6px; }
.ob-upload-zone p { margin: 4px 0; color: var(--muted); font-size: 13.5px; }
.ob-upload-zone .ob-upload-name { color: var(--high); font-weight: 600; }
.ob-comp-row { display: flex; gap: 12px; align-items: end; }
.ob-comp-row > .ob-field:first-child { flex: 2; }
.ob-comp-row > .ob-field:last-child { flex: 1; }
.ob-done-check { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; font-size: 14px; line-height: 1.45; }
.ob-done-check .ob-check { color: var(--high); font-size: 17px; line-height: 1.2; }
.ob-done-check .ob-skip { color: var(--muted); font-size: 17px; line-height: 1.2; }
.ob-sec-title { font-size: 14px; font-weight: 700; margin: 26px 0 6px; color: var(--fg); }
.ob-sec-sub { font-size: 12.5px; color: var(--muted); margin: 0 0 8px; line-height: 1.5; }
.ob-divider { height: 1px; background: var(--hairline); margin: 26px 0; }
.ob-or-divider { text-align: center; color: var(--muted); font-size: 13px; margin: 14px 0; }
.ob-done-actions { display: flex; gap: 12px; justify-content: center; margin-top: 22px; }
/* Progressive disclosure: everything the product can run without lives in here,
   collapsed, so the default path stays short without losing the capability. */
.ob-more { margin: 16px 0 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.ob-more > summary { cursor: pointer; padding: 10px 14px; font-size: 13.5px; font-weight: 600; color: var(--accent); list-style: none; }
.ob-more > summary::-webkit-details-marker { display: none; }
.ob-more > summary::before { content: '＋ '; font-weight: 700; }
.ob-more[open] > summary::before { content: '− '; }
.ob-more > summary .ob-more-why { font-weight: 400; color: var(--muted); }
.ob-more-body { padding: 6px 14px 16px; border-top: 1px solid var(--hairline); }
.ob-more-body .ob-field:last-child { margin-bottom: 0; }
.ob-search { width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; background: var(--surface); color: var(--fg); margin-bottom: 10px; }
.ob-linkbtn { background: none; border: none; color: var(--accent); font-size: 13px; font-weight: 600; cursor: pointer; padding: 6px 0; text-decoration: underline; text-underline-offset: 2px; }
.ob-note { font-size: 12.5px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
.ob-coverage { font-size: 12.5px; color: var(--muted); line-height: 1.6; margin: 10px 0 2px;
  padding: 10px 12px; border-radius: 8px; background: var(--surface-2, rgba(127,127,127,.07));
  border: 1px solid var(--border); }
.ob-coverage b { color: var(--fg); font-weight: 600; }
.ob-callout { margin-top: 26px; padding: 16px 18px; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 12px; }
.ob-callout h3 { margin: 0 0 8px; font-size: 15px; }
.ob-callout ol { margin: 0; padding-left: 20px; font-size: 13.5px; line-height: 1.65; }
.ob-callout code, .ob-code { background: var(--border); padding: 2px 6px; border-radius: 4px; font-size: 12.5px; }
.ob-banner { font-size: 13px; line-height: 1.5; padding: 10px 13px; border-radius: 9px; background: var(--accent-weak); border: 1px solid var(--border); margin-bottom: 16px; }
</style>
</head>
<body>
<main class="onboarding">

<!-- Step 1: who you are + what you want (merged; the old marketing-only screen
     is folded in as the hero so it costs no extra click) -->
<div class="ob-step active" data-step="1">
  <div class="ob-progress"><div class="dot current"></div><div class="dot"></div><div class="dot"></div></div>
  <div id="ob-restored" class="ob-banner" style="display:none"></div>
  <div id="ob-edit-note" class="ob-banner" style="display:none"></div>
  <div class="ob-hero">
    <div class="ob-icon">💼</div>
    <h1>Let's set up your job search</h1>
    <p>Two screens, about a minute. Everything here is editable later.</p>
  </div>
  <div class="ob-cards">
    <div class="ob-card"><div class="ob-card-ic">🔍</div><strong>Scan &amp; Score</strong><p>Finds open roles and scores each one against your profile.</p></div>
    <div class="ob-card"><div class="ob-card-ic">📄</div><strong>Apply Packs</strong><p>Writes a tailored resume, cover letter and form answers per role.</p></div>
    <div class="ob-card"><div class="ob-card-ic">📋</div><strong>Track It</strong><p>One board from first scan to signed offer.</p></div>
  </div>
  <div class="ob-note" style="text-align:center">⚙️ Scanning &amp; tracking are free. AI scoring and apply packs run in <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a> (Pro or Max plan).</div>

  <div class="ob-sec-title">About you</div>
  <div class="ob-sec-sub">Your name and email go on the resumes and cover letters this generates.</div>
  <div class="ob-row">
    <div class="ob-field">
      <label for="ob-name">Full name <span class="ob-req" title="required">*</span></label>
      <input type="text" id="ob-name" placeholder="Jane Smith" autocomplete="name">
      <div class="ob-err" id="ob-name-err"></div>
    </div>
    <div class="ob-field">
      <label for="ob-email">Email <span class="ob-req" title="required">*</span></label>
      <input type="email" id="ob-email" placeholder="jane@example.com" autocomplete="email">
      <div class="ob-err" id="ob-email-err"></div>
    </div>
  </div>
  <div class="ob-field">
    <label for="ob-location">Location <span class="ob-opt">(optional)</span></label>
    <div class="ob-hint">City and country is enough. It shapes how the AI scores location fit when it rates each role. The job boards we read are worldwide, so the scan itself will still surface jobs elsewhere.</div>
    <input type="text" id="ob-location" placeholder="Manchester, UK" autocomplete="address-level2">
  </div>
  <details class="ob-more">
    <summary>Add your LinkedIn <span class="ob-more-why">— optional, used on generated resumes</span></summary>
    <div class="ob-more-body">
      <div class="ob-field" style="margin-bottom:0">
        <label for="ob-linkedin">LinkedIn</label>
        <input type="text" id="ob-linkedin" placeholder="linkedin.com/in/yourname">
      </div>
    </div>
  </details>

  <div class="ob-sec-title">What you're looking for</div>
  <div class="ob-sec-sub">Your field filters the company suggestions on the next screen and the role ideas below. Pick as many as apply — or none.</div>
  <div class="ob-industry-grid" id="ob-industries">
    ${INDUSTRIES.map(ind => `<div class="ob-industry-card" data-id="${ind.id}" onclick="toggleIndustry(this)"><span class="ob-ic-icon">${ind.icon}</span><span>${escapeHtml(ind.label)}</span><span class="ob-ic-check">✓</span></div>`).join('')}
    <div id="ob-other-input" style="display:none;margin-top:8px"><input type="text" id="ob-other-text" placeholder="Describe your field (e.g. Nonprofit, Aerospace...)" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px;background:var(--surface);color:var(--fg)"></div>
  </div>

  <div class="ob-sec-title" style="margin-top:24px">Where you are in your career</div>
  <div class="ob-sec-sub">Sets which titles count as a good fit. Pick student and internships, co-ops and working-student roles stop being filtered out.</div>
  <div class="ob-choice-row" id="ob-stage">
    <div class="ob-industry-card" data-stage="student" onclick="setStage(this)"><span class="ob-ic-icon">🎓</span><span>Student / early career</span><span class="ob-ic-check">✓</span></div>
    <div class="ob-industry-card" data-stage="experienced" onclick="setStage(this)"><span class="ob-ic-icon">💼</span><span>Experienced</span><span class="ob-ic-check">✓</span></div>
  </div>
  <div id="ob-jobtypes-wrap" style="display:none">
    <div class="ob-sec-title" style="margin-top:18px">Type of position <span class="ob-opt">(optional)</span></div>
    <div class="ob-sec-sub">Pick any that apply. Each one adds the words boards actually post it under — a co-op is never listed as "Junior".</div>
    <div class="ob-industry-grid" id="ob-jobtypes">
      ${JOB_TYPES.map(t => `<div class="ob-industry-card" data-jobtype="${t.id}" onclick="toggleJobType(this)"><span class="ob-ic-icon">${t.icon}</span><span>${escapeHtml(t.label)}</span><span class="ob-ic-check">✓</span></div>`).join('')}
    </div>
  </div>

  <div class="ob-sec-title" style="margin-top:24px">Target roles <span class="ob-opt">(optional)</span></div>
  <div class="ob-sec-sub">How much should job titles narrow your scan?</div>
  <div class="ob-choice-row" id="ob-title-mode">
    <div class="ob-industry-card" data-titlemode="open" onclick="setTitleMode(this)"><span class="ob-ic-icon">🌐</span><span>Open to anything in my field</span><span class="ob-ic-check">✓</span></div>
    <div class="ob-industry-card" data-titlemode="titles" onclick="setTitleMode(this)"><span class="ob-ic-icon">🎯</span><span>Only these titles</span><span class="ob-ic-check">✓</span></div>
  </div>
  <div class="ob-sec-sub" id="ob-roles-hint" style="margin-top:8px">Job titles you'd take. Click the box to see common ones in your field, or type your own and press Enter. Not sure yet? Leave it empty and we'll keep every role these companies post.</div>
  <div style="position:relative" id="ob-roles-box">
    <div class="ob-tags" id="ob-roles-container" onclick="document.getElementById('ob-roles-input').focus()">
      <input type="text" id="ob-roles-input" placeholder="Click for ideas, or type a title and press Enter" autocomplete="off">
    </div>
    <div class="ob-suggestions" id="ob-roles-suggestions"></div>
  </div>

  <details class="ob-more">
    <summary>Pay, work style &amp; deal-breakers <span class="ob-more-why">— optional, sharpens how jobs are scored</span></summary>
    <div class="ob-more-body">
      <div class="ob-field">
        <label>Compensation</label>
        <div class="ob-hint">Open on pay is a real answer — pick it and pay is left out of scoring entirely, instead of a missing salary counting against a job.</div>
        <div class="ob-choice-row" id="ob-pay-mode" style="margin-bottom:10px">
          <div class="ob-industry-card" data-paymode="open" onclick="setPayMode(this)"><span class="ob-ic-icon">🤷</span><span>Open on pay</span><span class="ob-ic-check">✓</span></div>
          <div class="ob-industry-card" data-paymode="target" onclick="setPayMode(this)"><span class="ob-ic-icon">💰</span><span>I have a target range</span><span class="ob-ic-check">✓</span></div>
        </div>
        <div class="ob-hint" id="ob-comp-hint">The low end becomes your floor — roles known to pay below it get flagged and scored down.</div>
        <div class="ob-comp-row" id="ob-comp-row">
          <div class="ob-field" style="margin:0"><input type="text" id="ob-comp" placeholder="$120K-180K"></div>
          <div class="ob-field" style="margin:0">
            <select id="ob-currency"><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="CHF">CHF</option><option value="CAD">CAD</option><option value="AUD">AUD</option><option value="Other">Other</option></select>
          </div>
        </div>
      </div>
      <div class="ob-row">
        <div class="ob-field" style="margin:0">
          <label for="ob-workpref">Work preference</label>
          <div class="ob-hint">Shapes how location fit is scored.</div>
          <select id="ob-workpref"><option value="remote">Remote only</option><option value="hybrid" selected>Remote or hybrid near me</option><option value="onsite">Open to on-site / relocation</option></select>
        </div>
        <div class="ob-field" style="margin:0">
          <label for="ob-avoid">Rule anything out?</label>
          <div class="ob-hint">Industries, companies or levels to auto-skip. Comma-separated.</div>
          <input type="text" id="ob-avoid" placeholder="Crypto, my current employer, Director+" autocomplete="off">
        </div>
      </div>
    </div>
  </details>

  <details class="ob-more">
    <summary>See what your dashboard will look like <span class="ob-more-why">— sample data, retitled to your field</span></summary>
    <div class="ob-more-body">
      <div class="ob-note" id="ob-preview-caption" style="margin:0 0 8px">Invented companies and made-up jobs — this is the layout, not real listings. Pick a field above and the titles here change to match it.</div>
      <div class="ob-preview-tabs">
        <div class="ob-preview-tab active" onclick="switchPreview('tracker', this)">Pipeline</div>
        <div class="ob-preview-tab" onclick="switchPreview('triage', this)">Inbox</div>
      </div>
      <div class="ob-preview-wrap">
        <div class="ob-preview-panel" id="preview-tracker"><div class="disabled-overlay"></div>${previewTrackerHtml}</div>
        <div class="ob-preview-panel" id="preview-triage" style="display:none"><div class="disabled-overlay"></div>${previewTriageHtml}</div>
      </div>
    </div>
  </details>

  <div class="ob-actions">
    <div class="ob-spacer"></div>
    <button class="ob-btn ob-btn-primary" onclick="goStep(2)">Next →</button>
  </div>
  <a class="ob-manual" href="https://github.com/adrianmb0/GetTheJob#first-time-setup-manual" target="_blank" rel="noopener">I prefer to set up manually (edit the config files myself)</a>
</div>

<!-- Step 2: where to look + resume (merged: two short sections, one screen, one
     click to finish) -->
<div class="ob-step" data-step="2">
  <div class="ob-progress"><div class="dot done"></div><div class="dot current"></div><div class="dot"></div></div>
  <h2 style="text-align:center;margin-top:0">Where to look, and your resume</h2>
  <p class="muted" style="text-align:center;margin-top:4px">Last screen. Pick some job boards to watch, then add your resume so jobs can be scored against it.</p>

  <div class="ob-sec-title">1 · Companies to scan</div>
  <div class="ob-sec-sub" id="ob-company-hint"></div>
  <input type="search" class="ob-search" id="ob-company-search" placeholder="Search companies…" autocomplete="off">
  <div class="ob-industry-grid" id="ob-company-grid"></div>
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <button type="button" class="ob-linkbtn" id="ob-company-more" style="display:none" onclick="showAllCompanies()"></button>
    <div class="ob-note" id="ob-company-count" style="margin-top:6px"></div>
  </div>
  <!-- Always visible, never behind a details/summary: the single most important
       expectation to set before someone finishes setup is WHICH employers this can
       and cannot watch. A nurse who reads it here won't wonder why no hospital
       ever appears in her Inbox. -->
  <div class="ob-coverage" id="ob-coverage-note">
    <b>What the scanner can watch, and what it can't.</b>
    It reads job boards hosted on <b>Greenhouse</b>, <b>Ashby</b> and <b>Lever</b> — the platforms most tech companies and startups use.
    It cannot read <b>Workday</b>, <b>Taleo</b>, <b>SuccessFactors</b> or <b>TRAC</b>, which is where hospitals and the NHS, universities and schools, councils, law firms, banks and most large employers post their jobs.
    Those can't be tracked automatically yet — you can still paste any single job link into your Inbox by hand, and everything else here works on it.
    <span id="ob-coverage-field"></span>
  </div>
  <details class="ob-more">
    <summary>My company isn't listed <span class="ob-more-why">— paste its careers URL</span></summary>
    <div class="ob-more-body">
      <div class="ob-hint" style="font-size:12.5px;color:var(--muted);margin-bottom:8px">The scanner can read job boards hosted on three platforms: <b>Greenhouse</b>, <b>Ashby</b> and <b>Lever</b>. You can tell by the address — it contains <code class="ob-code">greenhouse.io</code>, <code class="ob-code">ashbyhq.com</code> or <code class="ob-code">lever.co</code>. Big employers on Workday or Taleo can't be auto-scanned; you can still paste individual job links into your Inbox later.</div>
      <div class="ob-comp-row">
        <div class="ob-field" style="flex:1;margin:0"><input type="text" id="ob-company-url" placeholder="https://jobs.ashbyhq.com/acme" autocomplete="off"></div>
        <button class="ob-btn ob-btn-secondary" id="ob-company-add" onclick="addCompanyUrl(this)" style="white-space:nowrap">Add</button>
      </div>
      <div id="ob-company-url-msg" style="font-size:12.5px;margin-top:6px"></div>
    </div>
  </details>

  <div class="ob-divider"></div>

  <div class="ob-sec-title">2 · Your resume <span class="ob-opt">(recommended)</span></div>
  <div class="ob-sec-sub">Scoring and tailored applications read this. You can add it later, but nothing can be scored until you do.</div>

  <div class="ob-upload-zone" id="ob-upload-zone">
    <div class="ob-upload-icon">📄</div>
    <p><strong>Drop your resume here</strong> or click to browse</p>
    <p style="font-size:12px">PDF only. Word document? Save it as PDF (File → Save As → PDF), or paste the text below.</p>
    <p class="ob-upload-name" id="ob-upload-name" style="display:none"></p>
    <input type="file" id="ob-file-input" accept=".pdf" style="display:none">
  </div>

  <div class="ob-or-divider">— or paste it as text —</div>

  <div class="ob-field">
    <!-- Placeholder is field-neutral, and refreshCvPlaceholder() puts the user's own
         first target role into the Experience line. It used to be a nursing CV,
         shown to everybody — including someone who had just picked Technology. -->
    <textarea id="ob-cv" placeholder="Paste your resume here — plain text is fine, headings help.&#10;&#10;Your name — city — your@email&#10;&#10;Summary&#10;What you do now, and what you want to do next. Two lines is plenty.&#10;&#10;Experience&#10;Employer — your job title (2019-now)&#10;- Something you did, with a number in it&#10;&#10;Education&#10;Your degree, your school"></textarea>
  </div>

  <details class="ob-more">
    <summary>Add your story <span class="ob-more-why">— optional, makes cover letters sound like you</span></summary>
    <div class="ob-more-body">
      <div class="ob-field">
        <label for="ob-headline">Professional headline</label>
        <div class="ob-hint">One line describing who you are. Used to open cover letters.</div>
        <input type="text" id="ob-headline" placeholder="e.g. ICU nurse turned clinical data analyst">
      </div>
      <div class="ob-field">
        <label for="ob-exit-story">Why are you looking?</label>
        <div class="ob-hint">1-2 sentences on what drives your search. Woven into cover letters to explain your motivation.</div>
        <textarea id="ob-exit-story" style="min-height:60px" placeholder="e.g. Nine years at the bedside taught me where the data breaks; I want to fix it upstream."></textarea>
      </div>
      <div class="ob-field">
        <label for="ob-strengths-input">Top strengths</label>
        <div class="ob-hint">3-5 things you're best at. Press Enter after each. These become bullets in your tailored materials.</div>
        <div class="ob-tags" id="ob-strengths-container" onclick="document.getElementById('ob-strengths-input').focus()">
          <input type="text" id="ob-strengths-input" placeholder="Type a strength and press Enter…" autocomplete="off">
        </div>
      </div>
      <div class="ob-field" style="margin-bottom:0">
        <label for="ob-proof-name">Key project or achievement</label>
        <div class="ob-hint">Your best story — something with a measurable result. Used in cover letters and interview prep.</div>
        <div class="ob-row">
          <div class="ob-field" style="flex:2;margin:0"><input type="text" id="ob-proof-name" placeholder="Project or achievement name"></div>
          <div class="ob-field" style="flex:1;margin:0"><input type="text" id="ob-proof-metric" placeholder="Result (e.g. 40% faster)"></div>
        </div>
        <textarea id="ob-proof-detail" style="min-height:50px;margin-top:8px" placeholder="What you did, what problem it solved, and the result."></textarea>
      </div>
    </div>
  </details>

  <div class="ob-actions">
    <button class="ob-btn ob-btn-secondary" onclick="goStep(1)">Back</button>
    <div class="ob-spacer"></div>
    <button class="ob-btn ob-btn-primary" onclick="completeOnboarding(this)">Finish setup →</button>
  </div>
</div>

<!-- Step 3: done + first scan -->
<div class="ob-step" data-step="3">
  <div class="ob-progress"><div class="dot done"></div><div class="dot done"></div><div class="dot done"></div></div>
  <div id="ob-done-head" style="text-align:center;margin-bottom:20px"></div>
  <div id="ob-done-list"></div>
  <div id="ob-done-where" class="ob-note" style="margin-top:10px"></div>
  <div id="ob-backup-note" class="muted" style="display:none;font-size:12.5px;text-align:center;margin:12px auto 0;max-width:560px;line-height:1.5;padding:9px 12px;background:var(--accent-weak);border-radius:9px"></div>
  <div class="ob-done-actions" style="flex-direction:column;align-items:center;gap:8px">
    <button class="ob-btn ob-btn-primary" onclick="runFirstScan(this)" id="ob-scan-btn" style="padding:12px 32px;font-size:15px">Run Your First Scan</button>
    <p class="muted" id="ob-scan-caption" style="font-size:12px;margin:0">Checks your companies' job boards and fills your Inbox. Free — no AI, no account.</p>
    <a href="/" id="ob-scan-skip" style="color:var(--muted);font-size:13px;margin-top:4px">Go to my dashboard instead</a>
  </div>
  <div id="ob-scan-progress" style="display:none;text-align:center;margin-top:16px">
    <p id="ob-scan-status" style="font-size:14px;line-height:1.55">Scanning job boards…</p>
    <div id="ob-scan-bar-wrap" style="width:200px;height:4px;background:var(--border);border-radius:2px;margin:8px auto"><div id="ob-scan-bar" style="height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 0.5s"></div></div>
  </div>

  <div class="ob-callout">
    <h3>What happens next</h3>
    <ol>
      <li><b>Find jobs — free.</b> The scan above (or <code class="ob-code">npm run scan</code> in the project folder) collects open roles from your companies.</li>
      <li><b>Score them — needs Claude Code.</b> Open the project folder in <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a> and run <code class="ob-code">/get-the-job triage</code>. Each role gets a 1-5 fit score and lands in your <a href="/?view=inbox" style="color:var(--accent);font-weight:600">Inbox</a>.</li>
      <li><b>Apply.</b> Send a good one to your Pipeline, then run <code class="ob-code">/get-the-job apply</code> for a tailored resume, cover letter and form answers. You review everything before it's sent.</li>
    </ol>
    <div class="ob-note" style="margin-top:10px">Scanning and tracking cost nothing. Steps 2 and 3 use your Claude Pro or Max plan.</div>
  </div>

  <details class="ob-more">
    <summary>Open the dashboard in one click next time <span class="ob-more-why">— macOS tip</span></summary>
    <div class="ob-more-body">
      <div class="ob-note" style="margin-top:4px">
        The project ships with a small launcher called <code class="ob-code">GetTheJob.app</code>. To pin it:
        <ol style="margin:8px 0 0;padding-left:20px;line-height:1.7">
          <li>Open the project folder you cloned.</li>
          <li>Drag <code class="ob-code">GetTheJob.app</code> onto your Dock.</li>
        </ol>
        <div style="margin-top:8px">One click then starts the server and opens this dashboard — no terminal needed. Not on a Mac? Run <code class="ob-code">npm start</code> in the project folder instead.</div>
      </div>
    </div>
  </details>
</div>

</main>

<script>
const INDUSTRIES = ${industriesJson};
const ROLE_SUGGESTIONS = ${roleSuggestionsJson};
const ROLE_ALIASES = ${roleAliasesJson};
const JOB_TYPES = ${jobTypesJson};
const COMPANY_CATALOG = ${companyCatalogJson};
const STARTER_COMPANIES = ${starterCompaniesJson};
const PREVIEW_MODE = ${previewMode ? 'true' : 'false'};
const PREFILL = ${prefillJson};
const LAST_STEP = 3;
const DRAFT_KEY = 'gtj-onboarding-draft';
const DRAFT_FIELDS = ['ob-name','ob-email','ob-location','ob-linkedin','ob-comp','ob-currency','ob-workpref','ob-avoid','ob-cv','ob-headline','ob-exit-story','ob-proof-name','ob-proof-metric','ob-proof-detail','ob-other-text'];

const state = {
  step: 1,
  industries: [],
  roles: [],
  strengths: [],
  companies: [],
  autoCompanies: false,
  uploadedFile: null,
  uploadedFileName: '',
  // true once this page has loaded the existing setup into the form. The server
  // uses it to tell "the user cleared this" apart from "the form never had it".
  prefilled: false,
  // The work-style select has a default selected option, so its value alone can't
  // tell us whether the user answered. This flips only on a real interaction.
  workprefTouched: false,
  // Career stage, job types, and the two "I'm flexible" answers. Each stays '' /
  // empty until clicked: an unanswered question must not be written to disk as a
  // stated preference (same contract as workprefTouched above), so leaving these
  // alone reproduces exactly the behaviour before they existed.
  stage: '',
  jobTypes: [],
  titleMode: '',
  payMode: '',
};

// Bind after the DOM exists; the select lives in a collapsed optional section.
document.addEventListener('DOMContentLoaded', function () {
  const wp = document.getElementById('ob-workpref');
  if (wp) wp.addEventListener('change', function () { state.workprefTouched = true; });
});

function obEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ---- draft persistence: a reload or an accidental tab close must not wipe
// everything the user typed (there is no server-side session).
function saveDraft() {
  if (PREVIEW_MODE) return;
  try {
    const fields = {};
    DRAFT_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) fields[id] = el.value; });
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      v: 1, step: state.step, industries: state.industries, roles: state.roles,
      strengths: state.strengths, companies: state.companies, fields: fields,
      prefilled: state.prefilled,
      stage: state.stage, jobTypes: state.jobTypes,
      titleMode: state.titleMode, payMode: state.payMode,
    }));
  } catch (e) { /* storage disabled — draft saving is best-effort */ }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
// Returns true when it put something back on the page, so the caller knows not to
// overwrite it with the on-disk prefill.
function restoreDraft() {
  if (PREVIEW_MODE) return false;
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
  if (!d || d.v !== 1) return false;
  const f = d.fields || {};
  Object.keys(f).forEach(id => { const el = document.getElementById(id); if (el && f[id]) el.value = f[id]; });
  (d.industries || []).forEach(id => {
    const card = document.querySelector('.ob-industry-card[data-id="' + id + '"]');
    if (card && !card.classList.contains('selected')) { card.classList.add('selected'); state.industries.push(id); }
  });
  const other = document.getElementById('ob-other-input');
  if (other) other.style.display = state.industries.indexOf('other') >= 0 ? '' : 'none';
  (d.roles || []).forEach(addRole);
  (d.strengths || []).forEach(addStrength);
  state.companies = Array.isArray(d.companies) ? d.companies : [];
  restoreChoices(d);
  const anything = (d.roles || []).length || state.companies.length || (f['ob-name'] || '').trim();
  if (anything) {
    // A draft written on top of a prefilled form already contains the merged
    // answers, so it must keep the same "everything is here" contract.
    if (d.prefilled) state.prefilled = true;
    const b = document.getElementById('ob-restored');
    if (b) { b.innerHTML = '↩︎ Picked up where you left off — your earlier answers are still here. <button type="button" class="ob-linkbtn" onclick="discardDraft()">Start over</button>'; b.style.display = ''; }
    if (d.step === 2) goStep(2);
    return true;
  }
  return false;
}

// ---- prefill: re-running setup loads what you already have, so changing one
// field cannot blank out the rest. Every value here is also re-submitted, which
// is what makes the re-run non-destructive.
function applyPrefill() {
  if (!PREFILL) return false;
  // Set first: addRole() below saves a draft, and that draft must already carry
  // the flag or a reload would look like a form that never had these answers.
  state.prefilled = true;
  const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  set('ob-name', PREFILL.name);
  set('ob-email', PREFILL.email);
  set('ob-location', PREFILL.location);
  set('ob-linkedin', PREFILL.linkedin);
  set('ob-comp', PREFILL.comp);
  set('ob-currency', PREFILL.currency);
  set('ob-workpref', PREFILL.workpref);
  // A work style restored from disk was answered on a previous run, so it counts as
  // answered now — otherwise a re-run would quietly drop it.
  if (PREFILL.workpref) state.workprefTouched = true;
  set('ob-avoid', PREFILL.avoid);
  set('ob-cv', PREFILL.cv);
  set('ob-headline', PREFILL.headline);
  set('ob-exit-story', PREFILL.exitStory);
  set('ob-proof-name', PREFILL.proofName);
  set('ob-proof-metric', PREFILL.proofMetric);
  set('ob-proof-detail', PREFILL.proofDetail);

  (PREFILL.industries || []).forEach(id => {
    const card = document.querySelector('.ob-industry-card[data-id="' + id + '"]');
    if (card && !card.classList.contains('selected')) card.classList.add('selected');
    if (state.industries.indexOf(id) < 0) state.industries.push(id);
  });
  const other = document.getElementById('ob-other-input');
  if (other) other.style.display = state.industries.indexOf('other') >= 0 ? '' : 'none';
  (PREFILL.roles || []).forEach(addRole);
  (PREFILL.strengths || []).forEach(addStrength);
  state.companies = (PREFILL.companies || []).slice();
  // A stored answer counts as answered now — same reasoning as workprefTouched
  // above, or a re-run would quietly drop it. Titles/pay show as chosen when the
  // file says "flexible", and otherwise only when there is something to show.
  restoreChoices({
    stage: PREFILL.careerStage,
    jobTypes: PREFILL.jobTypes || [],
    titleMode: PREFILL.titlesOpen ? 'open' : ((PREFILL.roles || []).length ? 'titles' : ''),
    payMode: PREFILL.payOpen ? 'open' : (PREFILL.comp ? 'target' : ''),
  });

  // Open the collapsed sections that hold restored answers — a value hidden
  // inside a closed <details> looks exactly like a value that was lost.
  if (PREFILL.linkedin) openDetailsFor('ob-linkedin');
  if (PREFILL.comp || PREFILL.payOpen || PREFILL.avoid || (PREFILL.workpref && PREFILL.workpref !== 'hybrid')) openDetailsFor('ob-comp');
  if (PREFILL.headline || PREFILL.exitStory || (PREFILL.strengths || []).length || PREFILL.proofName) openDetailsFor('ob-headline');
  return true;
}

// Put the card-pair answers back on the page, from a draft or from disk. Routed
// through the same setters the cards use so the dependent UI (job types shown,
// title box hidden, comp row hidden) can never disagree with the state.
function restoreChoices(src) {
  if (!src) return;
  const click = (rowId, attr, value) => {
    if (!value) return;
    const el = document.querySelector('#' + rowId + ' [data-' + attr + '="' + value + '"]');
    if (el) el.click();
  };
  click('ob-stage', 'stage', src.stage);
  (src.jobTypes || []).forEach(id => {
    const el = document.querySelector('#ob-jobtypes [data-jobtype="' + id + '"]');
    if (el && !el.classList.contains('selected')) el.click();
  });
  click('ob-title-mode', 'titlemode', src.titleMode);
  click('ob-pay-mode', 'paymode', src.payMode);
}

function openDetailsFor(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const d = el.closest('details');
  if (d) d.open = true;
}
function discardDraft() {
  clearDraft();
  location.reload();
}

// ---- validation: a required field that silently refuses to advance reads as a
// broken button, so every failure gets an inline message + a red field.
function setFieldError(id, msg) {
  const el = document.getElementById(id);
  const err = document.getElementById(id + '-err');
  if (el) { el.classList.add('ob-invalid'); el.setAttribute('aria-invalid', 'true'); if (err) el.setAttribute('aria-describedby', id + '-err'); }
  if (err) { err.textContent = msg; err.classList.add('show'); }
  if (el) el.focus();
}
function clearFieldError(id) {
  const el = document.getElementById(id);
  const err = document.getElementById(id + '-err');
  if (el) { el.classList.remove('ob-invalid'); el.removeAttribute('aria-invalid'); }
  if (err) { err.textContent = ''; err.classList.remove('show'); }
}
function looksLikeEmail(v) { return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(v); }
function validateBasics() {
  clearFieldError('ob-name'); clearFieldError('ob-email');
  const name = (document.getElementById('ob-name').value || '').trim();
  const email = (document.getElementById('ob-email').value || '').trim();
  if (!name) { setFieldError('ob-name', 'We need your name — it goes on every resume and cover letter this writes.'); return false; }
  if (!email) { setFieldError('ob-email', 'We need an email — applications you generate use it as your contact address.'); return false; }
  if (!looksLikeEmail(email)) { setFieldError('ob-email', "That doesn't look like an email address — check for a typo (you@example.com)."); return false; }
  return true;
}

function goStep(n) {
  if (n === 2 && state.step === 1 && !validateBasics()) return;
  const target = document.querySelector('[data-step="' + n + '"]');
  if (!target) return;
  document.querySelectorAll('.ob-step').forEach(el => el.classList.remove('active'));
  target.classList.add('active');
  state.step = n;
  if (n === 2) renderCompanies();
  if (n < LAST_STEP) saveDraft();
  window.scrollTo(0, 0);
}

function companyKey(c) { return (c.careers_url || '').toLowerCase(); }
function isCompanySelected(c) { return state.companies.some(x => companyKey(x) === companyKey(c)); }
function industryLabel(id) { const i = INDUSTRIES.filter(x => x.id === id)[0]; return i ? i.label : id; }

const COMPANY_CAP = 15;
let companyShowAll = false;

function everyCompany() {
  const seen = {}, out = [];
  Object.keys(COMPANY_CATALOG).forEach(id => COMPANY_CATALOG[id].forEach(c => {
    const k = companyKey(c); if (!seen[k]) { seen[k] = 1; out.push(c); }
  }));
  state.companies.forEach(c => { const k = companyKey(c); if (!seen[k]) { seen[k] = 1; out.push(c); } });
  return out;
}

// Companies to offer: scoped to the chosen fields, else a labelled starter set.
// Fields we have no curated list for are named out loud instead of silently
// falling back to an unrelated list.
function companyPool() {
  const withList = state.industries.filter(i => COMPANY_CATALOG[i] && COMPANY_CATALOG[i].length);
  const without = state.industries.filter(i => !(COMPANY_CATALOG[i] && COMPANY_CATALOG[i].length));
  const seen = {}, list = [];
  const add = c => { const k = companyKey(c); if (!seen[k]) { seen[k] = 1; list.push(c); } };
  withList.forEach(id => COMPANY_CATALOG[id].forEach(add));
  if (!withList.length) STARTER_COMPANIES.forEach(add);
  state.companies.forEach(add);
  return { list: list, withList: withList, without: without };
}

// Says what each curated list actually IS, in the user's own terms. The health list
// is US health-tech, not hospitals; the legal list is legal-tech, not law firms.
// Padding the lists with irrelevant employers would be the dishonest fix, so the
// lists stay small and the description stays accurate.
const FIELD_COVERAGE = {
  health: 'The health list is US health-tech, telehealth, mental-health and insurance employers — the roles are mostly analyst, operations, clinical-licence and software jobs. No hospital, trust or NHS employer is in it.',
  legal: 'The legal list is legal-tech companies plus the in-house legal, privacy and compliance teams of a few large employers. No law firm is in it.',
  education: 'The education list is ed-tech companies. No school, college, district or university is in it.',
  finance: 'The finance list is fintech companies. Banks, insurers and asset managers post on Workday, so none are in it.',
  consulting: 'Only three employers here: the big consultancies are all on Workday.',
  manufacturing: 'The manufacturing list is a handful of hardware and robotics companies. Traditional industrial employers are not on these platforms.',
  retail: 'The retail list is e-commerce and consumer-brand head offices — corporate roles, not store or warehouse jobs.',
  media: 'The media list is digital-media and creator-platform companies. Broadcasters and newspapers are not on these platforms.',
  climate: 'The climate list is climate-tech and energy startups — utilities are not on these platforms.',
};

function renderCompanies() {
  const grid = document.getElementById('ob-company-grid');
  const hint = document.getElementById('ob-company-hint');
  const fieldNote = document.getElementById('ob-coverage-field');
  if (!grid) return;
  if (fieldNote) {
    const lines = state.industries.map(id => FIELD_COVERAGE[id]).filter(Boolean);
    fieldNote.textContent = lines.length ? ' ' + lines.join(' ') : '';
  }
  const pool = companyPool();
  const searchEl = document.getElementById('ob-company-search');
  const q = ((searchEl && searchEl.value) || '').trim().toLowerCase();
  const base = q
    ? everyCompany().filter(c => c.name.toLowerCase().indexOf(q) >= 0)
    : pool.list;
  const visible = (companyShowAll || q) ? base : base.slice(0, COMPANY_CAP);
  // never hide something the user already picked
  state.companies.forEach(c => { if (!visible.some(x => companyKey(x) === companyKey(c))) visible.push(c); });

  if (hint) {
    let txt = '';
    if (pool.withList.length) {
      txt = 'Boards we can scan in ' + pool.withList.map(industryLabel).join(' and ') + '. Click any to track it.';
    } else {
      txt = 'A starter set across fields — search by name, or go Back and pick a field to narrow it.';
    }
    if (pool.without.length) {
      txt += ' We don\\'t have a curated list for ' + pool.without.map(industryLabel).join(' or ') +
        ' yet (most of those employers use Workday, which this scanner can\\'t read) — search below or paste a careers URL.';
    } else if (pool.withList.length && pool.list.length < 5) {
      txt += ' This list is short — most employers in that field are on Workday, which this scanner can\\'t read.';
    }
    hint.textContent = txt;
  }

  grid.innerHTML = visible.map(c =>
    '<div class="ob-industry-card' + (isCompanySelected(c) ? ' selected' : '') + '" data-key="' + obEsc(companyKey(c)) + '" onclick="toggleCompany(this)">' +
    '<span>' + obEsc(c.name) + '</span><span class="ob-ic-check">✓</span></div>'
  ).join('') || '<div class="ob-note">No company by that name in our list — paste its careers URL below instead.</div>';

  const moreBtn = document.getElementById('ob-company-more');
  if (moreBtn) {
    const hidden = base.length - visible.length;
    if (hidden > 0) { moreBtn.textContent = 'Show all ' + base.length + ' companies'; moreBtn.style.display = ''; }
    else { moreBtn.style.display = 'none'; }
  }
  renderCompanies._list = everyCompany();
  updateCompanyCount();
}

function showAllCompanies() { companyShowAll = true; renderCompanies(); }

function updateCompanyCount() {
  const el = document.getElementById('ob-company-count');
  if (!el) return;
  const n = state.companies.length;
  el.textContent = n
    ? n + (n === 1 ? ' company' : ' companies') + ' selected — you can change these later in Settings.'
    : "None selected — if you leave it empty we'll start you with 3 popular boards, which you can change in Settings.";
}

function toggleCompany(el) {
  const key = el.dataset.key;
  const c = (renderCompanies._list || []).filter(x => companyKey(x) === key)[0];
  if (!c) return;
  if (isCompanySelected(c)) {
    state.companies = state.companies.filter(x => companyKey(x) !== key);
    el.classList.remove('selected');
  } else {
    state.companies.push(c);
    el.classList.add('selected');
  }
  state.autoCompanies = false;
  updateCompanyCount();
  saveDraft();
}

async function addCompanyUrl(btn) {
  const input = document.getElementById('ob-company-url');
  const msg = document.getElementById('ob-company-url-msg');
  const url = (input.value || '').trim();
  if (!url) { input.focus(); return; }
  msg.style.color = 'var(--muted)';
  msg.textContent = 'Checking that board…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/onboarding/verify-company', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!data.ok) {
      msg.style.color = 'var(--danger)';
      msg.innerHTML = obEsc(data.error || "We couldn't read that board.") +
        (data.hint ? '<br><span class="muted">' + obEsc(data.hint) + '</span>' : '');
      return;
    }
    const c = { name: data.name, careers_url: data.careers_url };
    if (data.api) c.api = data.api;
    if (isCompanySelected(c)) {
      msg.style.color = 'var(--muted)';
      msg.textContent = data.name + ' is already in your list.';
    } else {
      state.companies.push(c);
      state.autoCompanies = false;
      renderCompanies();
      msg.style.color = 'var(--high)';
      msg.textContent = '✓ Added ' + data.name + ' — ' + data.count + ' open roles right now.';
      input.value = '';
      saveDraft();
    }
  } catch (e) {
    msg.style.color = 'var(--danger)';
    msg.textContent = 'Could not check that board: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function switchPreview(view, el) {
  document.querySelectorAll('.ob-preview-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('preview-tracker').style.display = view === 'tracker' ? '' : 'none';
  document.getElementById('preview-triage').style.display = view === 'triage' ? '' : 'none';
  if (el) el.classList.add('active');
}

// The dashboard peek is fictional sample data, but its job titles were hard-coded
// software roles ("ML Engineer, NLP", "AI Research Scientist"), so a nurse who had
// just ticked Healthcare two fields above was shown a software job search and could
// reasonably decide the product was not for her. The employers stay invented — they
// are not real listings and must not look like any — while the TITLES now come from
// her own answers: what she typed, plus the suggestion list for her field.
function previewTitles() {
  let titles = state.roles.slice();
  state.industries.forEach(id => { if (ROLE_SUGGESTIONS[id]) titles = titles.concat(ROLE_SUGGESTIONS[id]); });
  return dedupe(titles.filter(Boolean));
}

function refreshPreviewRoles() {
  const slots = document.querySelectorAll('#preview-tracker .ro, #preview-triage .lead-role');
  if (!slots.length) return;
  const cap = document.getElementById('ob-preview-caption');
  const titles = previewTitles();
  if (!titles.length) {
    // Nothing chosen yet — put the shipped demo titles back and say what they are.
    slots.forEach(el => { if (el.dataset.demo) el.textContent = el.dataset.demo; });
    if (cap) cap.textContent = 'Invented companies and made-up jobs — this is the layout, not real listings. Pick a field above and the titles here change to match it.';
    return;
  }
  slots.forEach(function (el, i) {
    if (!el.dataset.demo) el.dataset.demo = el.textContent;
    el.textContent = titles[i % titles.length];
  });
  const fields = state.industries.map(industryLabel);
  if (cap) {
    cap.textContent = 'Invented companies, real ' +
      (fields.length ? fields.join(' / ') : 'target') +
      ' job titles — this is the layout, not real listings.';
  }
}

// "Leave it empty and we'll show you everything these companies post" was only true
// when NO field was ticked. With a field ticked and no titles, the wizard writes a
// ~24-title curated filter from that field's examples — on a real 3-company scan
// that silently dropped 596 of 627 postings. The hint now states whichever of the
// two things will actually happen, and updates as the user ticks fields and adds
// titles. (See the portals.yml writer: expandRoleKeywords(roles), else the field's
// ROLE_SUGGESTIONS, else an empty positive list that keeps every title.)
function updateRolesHint() {
  const el = document.getElementById('ob-roles-hint');
  if (!el) return;
  const named = state.industries.map(industryLabel).filter(Boolean);
  const studentNote = state.stage === 'student'
    ? ' Internship, co-op and working-student titles are kept either way.'
    : '';
  // "Open" is not the same as leaving the box empty: empty still builds a filter
  // from your field's example titles, which on a real scan dropped most of a board.
  // Open writes no title filter at all.
  if (state.titleMode === 'open') {
    el.textContent = 'No title filter: every role these companies post reaches your Inbox and gets scored against your resume'
      + (named.length ? ' and your field (' + named.join(' / ') + ')' : '')
      + '. Expect a long list — the scoring is what sorts it.';
    return;
  }
  const base = "Job titles you'd take. Click the box to see common ones in your field, or type your own and press Enter. ";
  if (state.roles.length) {
    el.textContent = base + 'Only titles containing one of these are kept.' + studentNote;
    return;
  }
  el.textContent = (named.length
    ? base + "Leave it empty and we'll filter on the common " + named.join(' / ') +
      ' titles instead — that is a filter, so some postings get dropped. Pick "Open" above to keep everything.'
    : base + "Leave it empty and we'll keep every role these companies post — that can be hundreds.") + studentNote;
}

// ---- career stage / job types / the two "I'm flexible" answers.
// Each is a one-of-two card pair (or a multi-select for job types) rather than a
// select, because the flexible answer has to be as visible as the specific one —
// buried in a dropdown it reads as a fallback for people who didn't finish.
function selectOne(rowId, attr, value) {
  document.querySelectorAll('#' + rowId + ' .ob-industry-card').forEach(c => {
    c.classList.toggle('selected', c.dataset[attr] === value);
  });
}

function setStage(el) {
  state.stage = el.dataset.stage;
  selectOne('ob-stage', 'stage', state.stage);
  const wrap = document.getElementById('ob-jobtypes-wrap');
  if (wrap) wrap.style.display = state.stage === 'student' ? '' : 'none';
  // Job types only mean anything for a student, so switching away drops them
  // rather than leaving invisible answers to be submitted.
  if (state.stage !== 'student' && state.jobTypes.length) {
    state.jobTypes = [];
    document.querySelectorAll('#ob-jobtypes .ob-industry-card').forEach(c => c.classList.remove('selected'));
  }
  updateSuggestions();
  updateRolesHint();
  saveDraft();
}

function toggleJobType(el) {
  const id = el.dataset.jobtype;
  el.classList.toggle('selected');
  if (el.classList.contains('selected')) {
    if (state.jobTypes.indexOf(id) < 0) state.jobTypes.push(id);
  } else {
    state.jobTypes = state.jobTypes.filter(t => t !== id);
  }
  updateSuggestions();
  updateRolesHint();
  saveDraft();
}

function setTitleMode(el) {
  state.titleMode = el.dataset.titlemode;
  selectOne('ob-title-mode', 'titlemode', state.titleMode);
  // The tag box stays in the DOM (typed titles survive a change of mind) but is
  // hidden while "open" is chosen, so the screen can't show a title list that the
  // scan is about to ignore.
  const box = document.getElementById('ob-roles-box');
  if (box) box.style.display = state.titleMode === 'open' ? 'none' : '';
  updateRolesHint();
  saveDraft();
}

function setPayMode(el) {
  state.payMode = el.dataset.paymode;
  selectOne('ob-pay-mode', 'paymode', state.payMode);
  const open = state.payMode === 'open';
  const row = document.getElementById('ob-comp-row');
  const hint = document.getElementById('ob-comp-hint');
  const cur = document.getElementById('ob-currency');
  if (row) row.style.display = open ? 'none' : '';
  if (hint) hint.style.display = open ? 'none' : '';
  if (open) {
    // Clearing it is the honest move: a range left in a hidden field would be
    // written to disk as a floor the user just said they don't have.
    const comp = document.getElementById('ob-comp');
    if (comp) comp.value = '';
    if (cur) cur.value = 'USD';
  }
  saveDraft();
}

function toggleIndustry(el) {
  const id = el.dataset.id;
  el.classList.toggle('selected');
  if (el.classList.contains('selected')) {
    if (state.industries.indexOf(id) < 0) state.industries.push(id);
  } else {
    state.industries = state.industries.filter(i => i !== id);
  }
  const otherInput = document.getElementById('ob-other-input');
  if (otherInput) otherInput.style.display = state.industries.indexOf('other') >= 0 ? '' : 'none';
  companyShowAll = false;
  updateSuggestions();
  refreshPreviewRoles();
  refreshCvPlaceholder();
  updateRolesHint();
  saveDraft();
}

// Built with DOM nodes, never innerHTML: a typed role like '<b>x</b>' or one
// containing a quote must render as literal text and keep its remove button
// wired to the right value.
function addRole(role) {
  role = String(role == null ? '' : role).trim();
  if (!role || state.roles.indexOf(role) >= 0) return;
  state.roles.push(role);
  const tag = document.createElement('span');
  tag.className = 'ob-tag';
  const label = document.createElement('span');
  label.textContent = role;
  tag.appendChild(label);
  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Remove ' + role);
  x.onclick = function () { removeRole(x, role); };
  tag.appendChild(x);
  const input = document.getElementById('ob-roles-input');
  input.parentNode.insertBefore(tag, input);
  input.value = '';
  closeSuggestions();
  refreshPreviewRoles();
  refreshCvPlaceholder();
  updateRolesHint();
  saveDraft();
}

function removeRole(btn, role) {
  state.roles = state.roles.filter(r => r !== role);
  if (btn && btn.parentNode) btn.parentNode.remove();
  refreshPreviewRoles();
  refreshCvPlaceholder();
  updateRolesHint();
  saveDraft();
}

// The paste-your-resume example is field-neutral, so it can't show a nurse's CV to
// someone who picked Technology. Once a target role exists it goes in the example's
// Experience line, which is the one line where a real title actually helps.
function refreshCvPlaceholder() {
  const ta = document.getElementById('ob-cv');
  if (!ta) return;
  if (!ta.dataset.base) ta.dataset.base = ta.placeholder;
  const role = (state.roles[0] || '').trim();
  ta.placeholder = role && role.length <= 40
    ? ta.dataset.base.replace('your job title', role)
    : ta.dataset.base;
}

function dedupe(arr) {
  const seen = {}, out = [];
  arr.forEach(v => { const k = v.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(v); } });
  return out;
}
// Titles for the job types a student picked (all of them if they picked none), so
// the ideas list leads with "Intern" / "Co-op Student" instead of only offering the
// mid-level titles in ROLE_SUGGESTIONS.
function stageRoles() {
  if (state.stage !== 'student') return [];
  const ids = state.jobTypes.length ? state.jobTypes : JOB_TYPES.map(t => t.id);
  let out = [];
  JOB_TYPES.forEach(t => { if (ids.indexOf(t.id) >= 0) out = out.concat(t.titles); });
  return dedupe(out);
}
function scopedRoles() {
  let all = stageRoles();
  const src = state.industries.length ? state.industries : Object.keys(ROLE_SUGGESTIONS);
  src.forEach(id => { if (ROLE_SUGGESTIONS[id]) all = all.concat(ROLE_SUGGESTIONS[id]); });
  return dedupe(all);
}
function allRoles() {
  let all = [];
  Object.keys(ROLE_SUGGESTIONS).forEach(id => { all = all.concat(ROLE_SUGGESTIONS[id]); });
  return dedupe(all);
}

let sugHighlight = -1;
function updateSuggestions() {
  const input = document.getElementById('ob-roles-input');
  if (!input) return;
  const val = input.value.trim().toLowerCase();
  const notPicked = r => state.roles.indexOf(r) < 0;
  let list;
  if (!val) {
    // Open on focus with the field's common titles: a career changer who doesn't
    // know the target title has nothing to type yet.
    list = scopedRoles().filter(notPicked).slice(0, 10);
  } else {
    let hits = [];
    // "nurse" / "teacher" / "paralegal" — what people call their CURRENT job.
    Object.keys(ROLE_ALIASES).forEach(k => {
      if (k.indexOf(val) === 0 || (val.length > 3 && val.indexOf(k) === 0)) hits = hits.concat(ROLE_ALIASES[k]);
    });
    let matches = scopedRoles().filter(r => r.toLowerCase().indexOf(val) >= 0);
    if (!matches.length && !hits.length) matches = allRoles().filter(r => r.toLowerCase().indexOf(val) >= 0);
    list = dedupe(hits.concat(matches)).filter(notPicked).slice(0, 10);
  }
  const box = document.getElementById('ob-roles-suggestions');
  if (!list.length) { closeSuggestions(); return; }
  sugHighlight = -1;
  box.innerHTML = '';
  list.forEach((r, i) => {
    const d = document.createElement('div');
    d.setAttribute('data-idx', String(i));
    d.textContent = r;
    d.onmousedown = function (e) { e.preventDefault(); addRole(r); };
    box.appendChild(d);
  });
  box.classList.add('open');
}

function closeSuggestions() {
  const box = document.getElementById('ob-roles-suggestions');
  if (box) box.classList.remove('open');
  sugHighlight = -1;
}

const rolesInput = document.getElementById('ob-roles-input');
rolesInput.addEventListener('input', updateSuggestions);
rolesInput.addEventListener('focus', updateSuggestions);
rolesInput.addEventListener('keydown', (e) => {
  const box = document.getElementById('ob-roles-suggestions');
  const items = box.querySelectorAll('div');
  if (e.key === 'ArrowDown') { e.preventDefault(); sugHighlight = Math.min(sugHighlight + 1, items.length - 1); highlightSug(items); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sugHighlight = Math.max(sugHighlight - 1, 0); highlightSug(items); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (sugHighlight >= 0 && items[sugHighlight]) addRole(items[sugHighlight].textContent);
    else if (rolesInput.value.trim()) addRole(rolesInput.value);
  }
  else if (e.key === 'Escape') { closeSuggestions(); }
  else if (e.key === 'Backspace' && !rolesInput.value && state.roles.length > 0) {
    const last = state.roles.pop();
    const tags = document.querySelectorAll('#ob-roles-container .ob-tag');
    if (tags.length) tags[tags.length - 1].remove();
    saveDraft();
  }
});
rolesInput.addEventListener('blur', () => setTimeout(closeSuggestions, 150));

function highlightSug(items) {
  items.forEach((el, i) => el.classList.toggle('highlighted', i === sugHighlight));
}

const companySearch = document.getElementById('ob-company-search');
if (companySearch) companySearch.addEventListener('input', () => { renderCompanies(); });

// File upload
const uploadZone = document.getElementById('ob-upload-zone');
const fileInput = document.getElementById('ob-file-input');
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });

function handleFile(file) {
  const nameEl = document.getElementById('ob-upload-name');
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    // Inline, not alert(): a modal here is jarring and easy to mis-click away.
    nameEl.style.color = 'var(--danger)';
    nameEl.textContent = 'That is a ' + (file.name.split('.').pop() || 'unknown') + ' file. Save it as PDF first, or paste the text below.';
    nameEl.style.display = '';
    return;
  }
  state.uploadedFile = file;
  state.uploadedFileName = file.name;
  nameEl.style.color = '';
  nameEl.textContent = '✓ ' + file.name;
  nameEl.style.display = '';
}

// Strengths tag input
function removeStrength(btn, val) { state.strengths = state.strengths.filter(s => s !== val); if (btn && btn.parentNode) btn.parentNode.remove(); saveDraft(); }
function addStrength(val) {
  val = String(val == null ? '' : val).trim();
  if (!val || state.strengths.indexOf(val) >= 0) return;
  state.strengths.push(val);
  const tag = document.createElement('span');
  tag.className = 'ob-tag';
  const label = document.createElement('span');
  label.textContent = val;
  tag.appendChild(label);
  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Remove ' + val);
  x.onclick = function () { removeStrength(x, val); };
  tag.appendChild(x);
  const input = document.getElementById('ob-strengths-input');
  input.parentNode.insertBefore(tag, input);
  input.value = '';
  saveDraft();
}
const strengthsInput = document.getElementById('ob-strengths-input');
if (strengthsInput) {
  strengthsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addStrength(strengthsInput.value); }
    if (e.key === 'Backspace' && !strengthsInput.value && state.strengths.length > 0) {
      state.strengths.pop();
      const tags = document.querySelectorAll('#ob-strengths-container .ob-tag');
      if (tags.length) tags[tags.length - 1].remove();
      saveDraft();
    }
  });
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id && DRAFT_FIELDS.indexOf(e.target.id) >= 0) {
    if (e.target.id === 'ob-name' || e.target.id === 'ob-email') clearFieldError(e.target.id);
    saveDraft();
  }
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.id && DRAFT_FIELDS.indexOf(e.target.id) >= 0) saveDraft();
});

async function runFirstScan(btn) {
  const statusEl = document.getElementById('ob-scan-status');
  const caption = document.getElementById('ob-scan-caption');
  const barWrap = document.getElementById('ob-scan-bar-wrap');
  const bar = document.getElementById('ob-scan-bar');
  const finishUi = () => {
    if (caption) caption.style.display = 'none';
    if (barWrap) barWrap.style.display = 'none';
  };
  if (PREVIEW_MODE) {
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    document.getElementById('ob-scan-progress').style.display = '';
    let pct = 0;
    const iv = setInterval(() => { pct = Math.min(pct + 20, 100); bar.style.width = pct + '%'; }, 400);
    setTimeout(() => {
      clearInterval(iv);
      finishUi();
      statusEl.textContent = 'Preview complete — no scan was run and no files changed.';
      btn.style.display = 'none';
    }, 2500);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  document.getElementById('ob-scan-progress').style.display = '';
  const fail = (html) => {
    finishUi();
    statusEl.innerHTML = html;
    btn.disabled = false;
    btn.textContent = 'Try the scan again';
  };
  try {
    const res = await fetch('/api/run-scan', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) { fail('<b style="color:var(--danger)">Could not start the scan:</b> ' + obEsc(data.error || 'unknown error')); return; }
    let pct = 10;
    bar.style.width = '10%';
    const poll = setInterval(async () => {
      try {
        const sr = await fetch('/api/scan-status');
        const sd = await sr.json();
        pct = Math.min(pct + 10, 90);
        bar.style.width = pct + '%';
        if (sd.running) return;
        clearInterval(poll);
        bar.style.width = '100%';
        // The scan's exit code is the truth. Reporting success over a crash is
        // how a first-time user ends up staring at an empty Inbox.
        if (sd.exitCode !== 0) {
          fail('<b style="color:var(--danger)">The scan failed (exit ' + obEsc(sd.exitCode) + ').</b><br>' +
            (sd.tail ? '<span class="muted" style="font-size:12.5px">' + obEsc(sd.tail) + '</span><br>' : '') +
            '<span class="muted" style="font-size:12.5px">Run <code class="ob-code">npm run scan</code> in the project folder to see the full error.</span>');
          return;
        }
        finishUi();
        // Measured, not estimated.
        const took = sd.elapsedMs != null
          ? ' in ' + (sd.elapsedMs < 60000 ? (Math.round(sd.elapsedMs / 100) / 10) + 's' : Math.floor(sd.elapsedMs / 60000) + 'm ' + Math.round((sd.elapsedMs % 60000) / 1000) + 's')
          : '';
        if (sd.added > 0) {
          statusEl.innerHTML = '<b>Found ' + sd.added + ' new posting' + (sd.added === 1 ? '' : 's') + '</b> from ' + obEsc(sd.scanned || 0) + ' compan' + ((sd.scanned || 0) === 1 ? 'y' : 'ies') + obEsc(took) + '.<br>' +
            '<span class="muted" style="font-size:12.5px">They are queued, not scored yet. To score them: open the project folder in <b>Claude Code</b> and run <code class="ob-code">/get-the-job triage</code> — results appear in your <a href="/?view=inbox" style="color:var(--accent);font-weight:600">Inbox</a>.</span>';
        } else {
          statusEl.innerHTML = '<b>Scan finished — nothing new right now.</b><br>' +
            '<span class="muted" style="font-size:12.5px">Checked ' + obEsc(sd.scanned || 0) + ' compan' + ((sd.scanned || 0) === 1 ? 'y' : 'ies') + obEsc(took) +
            ((sd.found || 0) > 0 ? ' and looked at ' + obEsc(sd.found) + ' postings — none matched your target titles. Add more companies or widen your target roles in Settings.' : '. Add a few companies in Settings and scan again.') +
            '</span>';
        }
        btn.textContent = 'Go to my Inbox →';
        btn.disabled = false;
        btn.onclick = function () { location.href = '/?view=inbox'; };
      } catch (e) { /* transient — keep polling */ }
    }, 2000);
  } catch (e) {
    fail('<b style="color:var(--danger)">Could not start the scan:</b> ' + obEsc(e.message));
  }
}

// If the user picked no companies, start them with a few real boards rather than
// an empty tracked_companies list that makes every scan return nothing.
function ensureCompanies() {
  if (state.companies.length) return;
  const pool = companyPool().list;
  state.companies = (pool.length ? pool : STARTER_COMPANIES).slice(0, 3);
  state.autoCompanies = state.companies.length > 0;
}

async function completeOnboarding(btn) {
  if (btn) { btn.disabled = true; btn.textContent = PREVIEW_MODE ? 'Preview…' : 'Setting up…'; }
  const reset = () => { if (btn) { btn.disabled = false; btn.textContent = 'Finish setup →'; } };

  const val = id => (document.getElementById(id) ? (document.getElementById(id).value || '').trim() : '');
  const headline = val('ob-headline');
  const exitStory = val('ob-exit-story');
  const proofName = val('ob-proof-name');
  const proofMetric = val('ob-proof-metric');
  const proofDetail = val('ob-proof-detail');
  const cvText = document.getElementById('ob-cv') ? document.getElementById('ob-cv').value : '';
  const hasNarrative = !!(headline || exitStory || state.strengths.length || proofName);
  const hasCv = !!(cvText.trim() || state.uploadedFile);

  ensureCompanies();

  const buildDoneList = () => {
    const n = state.companies.length;
    const rolesTxt = state.roles.length ? state.roles.join(', ') : '';
    // Only claim scoring rules exist if the user actually set one. Saying ✓ over an
    // empty modes/_profile.md ("Target range: _not set_", "_None yet._") is a lie the
    // user discovers later, which costs more trust than an honest ○ costs now.
    const ruleBits = [];
    if (val('ob-comp')) ruleBits.push('pay floor');
    // "Open on pay" is an instruction to the scorer (leave comp out, don't penalize
    // a JD that omits salary), so it counts as a rule — but only because the user
    // picked it, never as the resting state of an untouched form.
    if (state.payMode === 'open') ruleBits.push('open on pay');
    if (val('ob-location') || (val('ob-workpref') && val('ob-workpref') !== 'hybrid')) ruleBits.push('location policy');
    if (val('ob-avoid')) ruleBits.push('deal-breakers');
    if (state.stage) ruleBits.push(state.stage === 'student' ? 'student / early career' : 'experienced');
    const jobTypeTxt = state.jobTypes
      .map(id => (JOB_TYPES.filter(t => t.id === id)[0] || {}).label).filter(Boolean).join(', ');
    const titlesOpen = state.titleMode === 'open';
    const items = [
      { label: 'Your profile — name, email' + (val('ob-location') ? ', location' : ''), ok: true },
      { label: ruleBits.length ? 'Your scoring rules — ' + ruleBits.join(', ') : 'Your scoring rules', ok: ruleBits.length > 0,
        hint: 'none set, so scoring leans on your roles and resume alone — add a pay floor or deal-breakers under Scoring rules in your Inbox' },
      { label: titlesOpen
          ? 'Target roles — open to anything in your field (no title filter)'
          : (rolesTxt ? 'Target roles — ' + rolesTxt : 'Target roles'),
        ok: titlesOpen || !!rolesTxt,
        note: titlesOpen ? 'every posting reaches your Inbox and gets scored' : '',
        hint: state.industries.length
          ? "not set, so we'll match the common job titles in your field — add your own titles any time to narrow it"
          : 'not set, so a scan keeps every role these companies post (that can be hundreds) — add a few titles to narrow it' },
      { label: n ? n + (n === 1 ? ' company' : ' companies') + ' to scan' + (state.autoCompanies ? ' (we picked these to get you started)' : '') : 'Companies to scan',
        ok: n > 0, hint: 'add some in Settings → Companies to scan, then run a scan' },
      { label: state.uploadedFile && !cvText.trim() ? 'Your resume (uploaded as a PDF)' : 'Your resume', ok: hasCv,
        note: state.uploadedFile && !cvText.trim() ? 'ask Claude Code to convert it to text on first use' : '',
        hint: 'we left you a blank one to fill in — paste your resume into cv.md in the project folder, or re-run setup' },
      { label: 'Your cover-letter story', ok: hasNarrative,
        hint: 'optional — cover letters read better with it; add it by re-running setup' },
    ];
    // Only a student sees this line: for everyone else "job types" is noise.
    if (state.stage === 'student') {
      items.splice(3, 0, {
        label: jobTypeTxt ? 'Job types — ' + jobTypeTxt : 'Job types',
        ok: !!jobTypeTxt,
        hint: 'none picked, so internships, co-ops, working-student and graduate roles are all kept',
      });
    }
    document.getElementById('ob-done-list').innerHTML = items.map(item =>
      '<div class="ob-done-check"><span class="' + (item.ok ? 'ob-check' : 'ob-skip') + '">' + (item.ok ? '✓' : '○') + '</span><div>' +
      obEsc(item.label) +
      (item.ok
        ? (item.note ? ' <span class="muted">— ' + obEsc(item.note) + '</span>' : '')
        : ' <span class="muted">— ' + obEsc(item.hint || 'you can add this later') + '</span>') +
      '</div></div>'
    ).join('');

    const head = document.getElementById('ob-done-head');
    const canScan = n > 0;
    if (canScan && hasCv) {
      head.innerHTML = '<div style="font-size:34px;margin-bottom:2px">🎉</div><h2 style="margin:0 0 6px">You\\'re all set</h2>' +
        '<p class="muted" style="margin:0">Your workspace is ready. Run the first scan below.</p>';
    } else if (canScan) {
      head.innerHTML = '<div style="font-size:34px;margin-bottom:2px">✅</div><h2 style="margin:0 0 6px">Setup saved — add your resume when you can</h2>' +
        '<p class="muted" style="margin:0">Scanning works right now. Nothing can be <b>scored</b> until your resume is in, so that is the one thing worth finishing.</p>';
    } else {
      head.innerHTML = '<div style="font-size:34px;margin-bottom:2px">✅</div><h2 style="margin:0 0 6px">Setup saved — add somewhere to look</h2>' +
        '<p class="muted" style="margin:0">There are no companies to scan yet, so a scan would find nothing. Add a few and you are away.</p>';
    }
    const where = document.getElementById('ob-done-where');
    if (where) where.innerHTML = 'All of this is saved as plain text inside your project folder — <code class="ob-code">config/profile.yml</code> (profile), <code class="ob-code">portals.yml</code> (companies &amp; titles), <code class="ob-code">modes/_profile.md</code> (scoring rules) and <code class="ob-code">cv.md</code> (resume). Edit them by hand any time, or ask Claude Code to.';

    // Say what it will read, not how long it will take: duration is a function of
    // how many boards there are, and the only honest number is the one measured
    // when it finishes (which runFirstScan then reports).
    const capN = document.getElementById('ob-scan-caption');
    if (capN && canScan) {
      capN.textContent = "Reads the job boards of your " + n + (n === 1 ? ' company' : ' companies') +
        ' and fills your Inbox. Free — no AI, no account. It reports how long it took when it finishes.';
    }
    const scanBtn = document.getElementById('ob-scan-btn');
    if (scanBtn && !canScan) {
      scanBtn.disabled = true;
      scanBtn.title = 'Add at least one company first';
      const cap = document.getElementById('ob-scan-caption');
      if (cap) cap.innerHTML = 'Nothing to scan yet — <a href="/settings" style="color:var(--accent);font-weight:600">add companies in Settings</a> first.';
    }
  };

  if (PREVIEW_MODE) {
    buildDoneList();
    const actionsEl = document.querySelector('[data-step="3"] .ob-done-actions');
    if (actionsEl) actionsEl.innerHTML = '<a href="/" class="ob-btn ob-btn-secondary" style="text-decoration:none">Back to dashboard</a><span class="muted" style="padding:10px">Preview only — no files were changed.</span>';
    goStep(3);
    return;
  }

  const payload = {
    name: val('ob-name'),
    email: val('ob-email'),
    location: val('ob-location'),
    linkedin: val('ob-linkedin'),
    industries: state.industries,
    roles: state.roles,
    companies: state.companies,
    // '' when the question was never answered — the server keeps whatever is on
    // disk in that case instead of recording a default nobody chose.
    careerStage: state.stage,
    jobTypes: state.stage === 'student' ? state.jobTypes : [],
    titlesOpen: state.titleMode === 'open',
    titleModeSet: state.titleMode !== '',
    payOpen: state.payMode === 'open',
    payModeSet: state.payMode !== '',
    comp: val('ob-comp'),
    currency: document.getElementById('ob-currency') ? document.getElementById('ob-currency').value : 'USD',
    workpref: document.getElementById('ob-workpref') ? document.getElementById('ob-workpref').value : 'hybrid',
    // Did the user actually answer, or is this just the select's default? The server
    // refuses to record an unanswered work style as a stated preference.
    workprefSet: state.workprefTouched === true,
    avoid: val('ob-avoid'),
    cv: cvText,
    headline: headline,
    exitStory: exitStory,
    strengths: state.strengths,
    proofName: proofName,
    proofMetric: proofMetric,
    proofDetail: proofDetail,
    // Tells the server this form was showing the full existing setup, so an empty
    // field here means "the user cleared it", not "the form never knew about it".
    prefilled: state.prefilled === true,
  };

  let data;
  try {
    if (state.uploadedFile) {
      const formData = new FormData();
      formData.append('pdf', state.uploadedFile);
      formData.append('payload', JSON.stringify(payload));
      data = await (await fetch('/api/onboarding/complete', { method: 'POST', body: formData })).json();
    } else {
      data = await (await fetch('/api/onboarding/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })).json();
    }
  } catch (e) {
    showSetupError(e.message);
    reset();
    return;
  }
  if (!data || !data.ok) { showSetupError((data && data.error) || 'unknown error'); reset(); return; }

  clearDraft();
  buildDoneList();
  const backupNote = document.getElementById('ob-backup-note');
  if (backupNote) {
    backupNote.innerHTML = data.backup
      ? '🛟 Your previous setup was backed up to <code class="ob-code">' + obEsc(data.backup) + '</code> — restore from there if anything looks wrong.'
      : '';
    backupNote.style.display = data.backup ? '' : 'none';
  }
  goStep(3);
}

// Inline error instead of alert(): a modal on the last click of setup is the
// worst possible place for one, and it tells the user nothing actionable.
function showSetupError(msg) {
  const step = document.querySelector('[data-step="2"]');
  if (!step) return;
  let box = document.getElementById('ob-setup-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ob-setup-error';
    box.className = 'ob-banner';
    box.style.borderColor = 'var(--danger)';
    step.querySelector('.ob-actions').insertAdjacentElement('beforebegin', box);
  }
  box.innerHTML = '<b style="color:var(--danger)">Setup could not be saved:</b> ' + obEsc(msg) +
    '<br><span class="muted">Nothing was lost — your answers are still on this page. Try again, or set up manually by editing the config files.</span>';
  box.scrollIntoView({ block: 'center' });
}

// A draft (an interrupted run) wins over the on-disk prefill: it is the newer of
// the two, and it was itself seeded from disk.
if (!restoreDraft()) applyPrefill();
updateCompanyCount();
// Whatever the field ended up being (draft, prefill, or nothing), the dashboard
// peek must show titles from THAT field, not the software ones baked into the demo.
refreshPreviewRoles();
refreshCvPlaceholder();
updateRolesHint();
if (PREFILL) {
  // "Let's set up your job search / two screens, about a minute" is first-run
  // copy; on a re-run it misdescribes what is about to happen.
  const h = document.querySelector('.ob-hero h1');
  if (h) h.textContent = 'Update your setup';
  const hp = document.querySelector('.ob-hero p');
  if (hp) hp.textContent = 'Your current answers are already filled in below. Change what you need — the rest stays exactly as it is.';
  const n = document.getElementById('ob-edit-note');
  if (n) {
    // No dialog, and no scaremongering: with prefill in place a re-run changes
    // only what you change. Say that, and say where the backup goes.
    n.innerHTML = '✏️ <b>Editing your existing setup.</b> Everything below is filled in with what you have now — change what you want and leave the rest. ' +
      'Skipping a section keeps it as it is; nothing is cleared just because you did not retype it. ' +
      'A timestamped copy of <code class="ob-code">config/profile.yml</code>, <code class="ob-code">portals.yml</code>, <code class="ob-code">modes/_profile.md</code> and <code class="ob-code">cv.md</code> is saved to <code class="ob-code">backups/setup-&lt;date&gt;/</code> before anything is written.';
    n.style.display = '';
  }
}
</script>
</body>
</html>`;
}

// ----- parsers -----

function parseApplicationsMd(text) {
  // Pull the first markdown table from applications.md
  const lines = text.split('\n');
  const rows = [];
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*\|/.test(ln)) {
      const cells = ln.split('|').slice(1, -1).map(s => s.trim());
      // skip separator rows
      if (cells.every(c => /^[-:\s]+$/.test(c))) continue;
      if (!header) {
        header = cells;
      } else {
        rows.push(cells);
      }
    }
  }
  return { header: header || [], rows };
}

function parseTsv(text) {
  const lines = text.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map(l => l.split('\t'));
  return { header, rows };
}

// Extract `**URL:**` from a report file. Cached by mtime.
const _urlCache = new Map();
function extractReportUrl(reportPath) {
  try {
    const abs = join(ROOT, reportPath);
    if (!existsSync(abs)) return '';
    const st = statSync(abs);
    const key = abs + ':' + st.mtimeMs;
    if (_urlCache.has(key)) return _urlCache.get(key);
    const content = readFileSync(abs, 'utf8').slice(0, 4000); // header only
    const m = content.match(/^\*\*URL:\*\*\s*(.+?)\s*$/m);
    const url = m ? m[1].trim() : '';
    _urlCache.set(key, url);
    return url;
  } catch { return ''; }
}

function isSafeJobUrl(url) {
  return typeof url === 'string'
    && /^https?:\/\/[a-zA-Z0-9._\-]+(:[0-9]+)?(\/[a-zA-Z0-9._\-~:/?#@!$&'()*+,;=%]*)?$/.test(url)
    && !url.includes('"') && !url.includes("'") && !url.includes('\\') && !url.includes('`')
    && !url.includes('$(') && !url.includes('\n');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 8192) { req.destroy(); reject(new Error('payload too large')); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readOnboardingBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 500_000) { req.destroy(); reject(new Error('payload too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function readMultipart(req, contentType) {
  return new Promise((resolve, reject) => {
    const m = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!m) return reject(new Error('no boundary'));
    const boundary = m[1] || m[2];
    const chunks = [];
    let len = 0;
    req.on('data', chunk => { chunks.push(chunk); len += chunk.length; if (len > 10_000_000) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const sep = Buffer.from('--' + boundary);
      const fields = {};
      const files = {};
      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(sep, pos);
        if (start === -1) break;
        const afterSep = start + sep.length;
        if (buf[afterSep] === 0x2d && buf[afterSep + 1] === 0x2d) break;
        const headerEnd = buf.indexOf('\r\n\r\n', afterSep);
        if (headerEnd === -1) break;
        const headerStr = buf.slice(afterSep, headerEnd).toString();
        const bodyStart = headerEnd + 4;
        const nextSep = buf.indexOf(sep, bodyStart);
        const bodyEnd = nextSep === -1 ? buf.length : nextSep - 2;
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]+)"/);
        if (nameMatch) {
          if (filenameMatch) {
            files[nameMatch[1]] = buf.slice(bodyStart, bodyEnd);
          } else {
            fields[nameMatch[1]] = buf.slice(bodyStart, bodyEnd).toString();
          }
        }
        pos = nextSep === -1 ? buf.length : nextSep;
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

// Spawn a new Terminal window, cd into the project, run `claude /get-the-job apply <url>`.
function spawnTerminalApply(url) {
  if (!isSafeJobUrl(url)) throw new Error('Invalid URL');
  // ROOT is constructed from import.meta.url, so it doesn't contain hostile chars,
  // but escape single quotes defensively.
  const safeRoot = ROOT.replace(/'/g, `'\\''`);
  const inner = `cd '${safeRoot}' && claude '/get-the-job apply ${url}'`;
  const script = `tell application "Terminal"\n  activate\n  do script "${inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
  const p = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
  p.unref();
}

const CANONICAL_STATUSES = new Set([
  'Shortlisted', 'Evaluated', 'Applied', 'Responded', 'Interview',
  'Offer', 'Interviewed - Rejected', 'Rejected', 'Discarded', 'SKIP'
]);

// Set a row's status to any canonical value. Atomic write + .bak.
function setRowStatus(numRaw, newStatus) {
  const num = String(numRaw || '').trim();
  if (!/^\d+$/.test(num)) throw new Error('Invalid row number');
  if (!CANONICAL_STATUSES.has(newStatus)) throw new Error('Invalid status: ' + newStatus);
  const path = join(ROOT, 'data', 'applications.md');
  if (!existsSync(path)) throw new Error('applications.md not found');
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  const headerLineIdx = lines.findIndex(l => /^\s*\|\s*#\s*\|/.test(l));
  if (headerLineIdx === -1) throw new Error('Tracker header not found');
  const header = lines[headerLineIdx].split('|').slice(1, -1).map(s => s.trim());
  const statusIdx = header.findIndex(h => /^status$/i.test(h));
  const notesIdx = header.findIndex(h => /^notes$/i.test(h));
  if (statusIdx === -1) throw new Error('Status column not found');
  const rowRe = new RegExp('^\\s*\\|\\s*' + num + '\\s*\\|');
  let updated = false, noChange = false;
  for (let i = headerLineIdx + 2; i < lines.length; i++) {
    if (!rowRe.test(lines[i])) continue;
    const cells = lines[i].split('|');
    const dataStart = 1;
    const statusCellIdx = dataStart + statusIdx;
    const currentStatus = (cells[statusCellIdx] || '').trim();
    if (currentStatus === newStatus) { noChange = true; break; }
    const prevPad = cells[statusCellIdx].match(/^(\s*)(.*?)(\s*)$/);
    cells[statusCellIdx] = (prevPad ? prevPad[1] : ' ') + newStatus + (prevPad ? prevPad[3] : ' ');
    if (notesIdx >= 0) {
      const noteIdxCell = dataStart + notesIdx;
      const today = new Date().toISOString().slice(0, 10);
      const existing = (cells[noteIdxCell] || '').replace(/^\s+|\s+$/g, '');
      const stamp = `${newStatus.toLowerCase()} ${today} via dashboard`;
      const newNote = existing ? `${existing}; ${stamp}` : stamp;
      cells[noteIdxCell] = ' ' + newNote + ' ';
    }
    lines[i] = cells.join('|');
    updated = true;
    break;
  }
  if (noChange) return { ok: true, noChange: true };
  if (!updated) throw new Error('Row not found');
  copyFileSync(path, path + '.bak');
  const tmp = path + '.tmp';
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, path);
  return { ok: true };
}

// Shortlist a job from triage into applications.md as status=Shortlisted.
// Creates a stub report file holding the URL (so existing tooling that pulls
// URLs from report headers keeps working). Idempotent: if the URL is already
// in the tracker, returns ok:true with noChange:true.
function shortlistFromTriage({ url, company, role, score, note }) {
  if (!isSafeJobUrl(url)) throw new Error('Invalid URL');
  if (!company || !role) throw new Error('Missing company or role');
  const cleanCompany = String(company).slice(0, 80).trim();
  const cleanRole = String(role).slice(0, 200).trim();
  const cleanScore = String(score || '').match(/[0-9]+(\.[0-9]+)?/) ? `${score}/5` : 'N/A';
  const cleanNote = String(note || '').replace(/[|\n\r\t]/g, ' ').slice(0, 400).trim();

  const trackerPath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(trackerPath)) throw new Error('applications.md not found');

  // Dedup: walk linked reports and pull URLs from their headers
  const existing = readFileSync(trackerPath, 'utf8');
  const reportPaths = Array.from(existing.matchAll(/reports\/[\w.\-]+\.md/g)).map(m => m[0]);
  for (const rp of new Set(reportPaths)) {
    if (extractReportUrl(rp) === url) {
      return { ok: true, noChange: true, reason: 'URL already in applications.md' };
    }
  }

  // Next row number = max existing # + 1
  const lines = existing.split('\n');
  let maxNum = 0;
  for (const ln of lines) {
    const m = ln.match(/^\s*\|\s*(\d+)\s*\|/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  const nextNum = maxNum + 1;
  const today = new Date().toISOString().slice(0, 10);

  // Slug for report filename: alnum + dashes only
  const slug = cleanCompany
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 40) || 'shortlist';
  const reportFile = `reports/shortlist-${slug}-${today}.md`;
  const reportAbs = join(ROOT, reportFile);
  // If the path collides, append the row num for uniqueness
  let finalReportFile = reportFile;
  let finalReportAbs = reportAbs;
  if (existsSync(finalReportAbs)) {
    finalReportFile = `reports/shortlist-${slug}-${today}-${nextNum}.md`;
    finalReportAbs = join(ROOT, finalReportFile);
  }
  const stub = `# ${cleanCompany} — ${cleanRole}

**URL:** ${url}
**Score:** ${cleanScore}
**Status:** Shortlisted from triage on ${today}
**Legitimacy:** unconfirmed (shortlist stub — no evaluation yet)

---

No evaluation has been run for this posting. The user shortlisted it from triage with intent to apply.

Run \`/get-the-job apply ${url}\` to generate the full A–G report and proceed with the application.

## Triage signal
- Score: ${cleanScore}
- Note: ${cleanNote || '(none)'}
`;
  writeFileSync(finalReportAbs, stub);

  // Append the row. Tracker columns: #, Date, Company, Role, Score, Status, PDF, Report, Notes
  const noteCell = cleanNote
    ? `Shortlisted from triage; ${cleanNote}`
    : 'Shortlisted from triage';
  const newRow = `| ${nextNum} | ${today} | ${cleanCompany} | ${cleanRole} | ${cleanScore} | Shortlisted | ❌ | [${String(nextNum).padStart(3, '0')}](${finalReportFile}) | ${noteCell} |`;

  copyFileSync(trackerPath, trackerPath + '.bak');
  // Insert at the top of the data rows (right after the header separator)
  const headerIdx = lines.findIndex(l => /^\s*\|\s*#\s*\|/.test(l));
  if (headerIdx === -1) throw new Error('Tracker header not found');
  lines.splice(headerIdx + 2, 0, newRow);
  const tmp = trackerPath + '.tmp';
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, trackerPath);

  // Also remove from triage — once shortlisted, it shouldn't clutter the triage view.
  // Silent: if the URL isn't in triage (rare edge case), just move on.
  let triageRemoved = false;
  try {
    const r = dismissTriageRow(url);
    triageRemoved = !!r.ok;
  } catch { /* ignore */ }

  return { ok: true, num: nextNum, report: finalReportFile, triageRemoved };
}

// Remove a row from data/triage-scores.tsv by exact URL match. Atomic write + .bak.
function dismissTriageRow(urlRaw) {
  if (!isSafeJobUrl(urlRaw)) throw new Error('Invalid URL');
  const path = join(ROOT, 'data', 'triage-scores.tsv');
  if (!existsSync(path)) throw new Error('triage-scores.tsv not found');
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  let removed = 0;
  const kept = lines.filter((line, i) => {
    if (i === 0) return true; // header
    if (!line) return true;   // preserve trailing blanks
    const firstCell = line.split('\t')[0];
    if (firstCell === urlRaw) { removed++; return false; }
    return true;
  });
  if (removed === 0) return { ok: false, error: 'URL not found in triage-scores.tsv' };
  copyFileSync(path, path + '.bak');
  const tmp = path + '.tmp';
  writeFileSync(tmp, kept.join('\n'));
  renameSync(tmp, path);
  return { ok: true, removed };
}

// Delete a row from applications.md. Atomic write + .bak.
function deleteRowFromTracker(numRaw) {
  const num = String(numRaw || '').trim();
  if (!/^\d+$/.test(num)) throw new Error('Invalid row number');
  const path = join(ROOT, 'data', 'applications.md');
  if (!existsSync(path)) throw new Error('applications.md not found');
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  const headerLineIdx = lines.findIndex(l => /^\s*\|\s*#\s*\|/.test(l));
  if (headerLineIdx === -1) throw new Error('Tracker header not found');
  const rowRe = new RegExp('^\\s*\\|\\s*' + num + '\\s*\\|');
  let removeIdx = -1;
  for (let i = headerLineIdx + 2; i < lines.length; i++) {
    if (rowRe.test(lines[i])) { removeIdx = i; break; }
  }
  if (removeIdx === -1) throw new Error('Row not found');
  copyFileSync(path, path + '.bak');
  lines.splice(removeIdx, 1);
  const tmp = path + '.tmp';
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, path);
  return { ok: true };
}

// ----- apply pack helpers -----

// Find a data/apply/{num}-*.md file for a given tracker row number.
function findApplyPackForRow(num) {
  const dir = join(ROOT, 'data', 'apply');
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    const prefix = `${num}-`;
    const match = files.find(f => f.startsWith(prefix));
    return match ? `data/apply/${match}` : null;
  } catch { return null; }
}

// Parse PDF filenames from the apply-pack markdown body.
// The pack's own "## Files" section declares the canonical CV/cover PDFs as links to output/.
// Returns {cv, cover} (filenames only, no path).
function findOutputPdfsFromPack(md) {
  const out = { cv: null, cover: null };
  // Match output/<file>.pdf, or output/<per-job folder>/<file>.pdf, in any link
  // target. Strip any "../../" prefix. Two naming conventions are in play: the
  // older flat cv-*.pdf / cover-*.pdf, and the current per-job folders holding
  // AdrianMeloResume{Company}.pdf / AdrianMeloCL{Company}.pdf.
  const re = /output\/((?:[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+\.pdf)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const rel = m[1];
    if (rel.includes('..')) continue;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const isCv = /^cv-/i.test(base) || /resume/i.test(base);
    const isCover = /^cover-/i.test(base) || /cover.?letter/i.test(base) || /CL[A-Z]/.test(base);
    if (isCv && !isCover && !out.cv) out.cv = rel;
    else if (isCover && !out.cover) out.cover = rel;
  }
  // Fallback: if file exists in output/, keep it; otherwise null it
  for (const k of ['cv', 'cover']) {
    if (out[k] && !existsSync(join(ROOT, 'output', out[k]))) out[k] = null;
  }
  return out;
}

// Derive a company-slug from a row's company+role for matching output filenames.
function slugifyForOutput(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Render the apply-pack view: form answers + embedded CV PDF + embedded cover letter PDF.
function renderApplyPack(query) {
  const num = String(query.row || '').trim();
  if (!/^\d+$/.test(num)) {
    return { status: 400, body: shell('Bad request', '<h1>Bad request</h1><p>Missing or invalid row number.</p><p><a href="/?view=pipeline">← Back</a></p>') };
  }
  const packPath = findApplyPackForRow(num);
  if (!packPath) {
    return { status: 404, body: shell('No apply pack', `<h1>No apply pack for row #${escapeHtml(num)}</h1><p>Run <code>/get-the-job apply &lt;url&gt;</code> in the terminal to generate one.</p><p><a href="/?view=pipeline">← Back</a></p>`) };
  }
  const md = readFileSync(join(ROOT, packPath), 'utf8');
  const { cv, cover } = findOutputPdfsFromPack(md);
  const answersHtml = renderMarkdown(md);

  const docBtn = (label, icon, file) => {
    if (!file) return `<button class="doc-btn disabled" disabled title="Not generated yet">${icon} ${escapeHtml(label)}</button>`;
    const url = `/output?file=${encodeURIComponent(file)}`;
    return `<button class="doc-btn" onclick="openDoc('${escapeHtml(url)}', '${escapeHtml(label)}')">${icon} ${escapeHtml(label)}</button>
      <a class="doc-btn-secondary" href="${url}" target="_blank" rel="noopener" title="Open in new tab">↗</a>`;
  };

  const body = `
<p><a href="/?view=pipeline">← Back</a></p>
<h1>Apply Pack — Row #${escapeHtml(num)}</h1>

<div class="doc-bar">
  <div class="doc-group">${docBtn('Tailored CV', '📄', cv)}</div>
  <div class="doc-group">${docBtn('Cover letter', '✉️', cover)}</div>
</div>

<article class="report-body apply-answers-full">${answersHtml}</article>

<div id="doc-overlay" class="doc-overlay" onclick="if (event.target === this) closeDoc()">
  <div class="doc-overlay-inner">
    <div class="doc-overlay-head">
      <span id="doc-title">Document</span>
      <div class="doc-overlay-actions">
        <a id="doc-open-tab" href="#" target="_blank" rel="noopener" title="Open in new tab">Open in new tab ↗</a>
        <button class="doc-close" onclick="closeDoc()" title="Close (Esc)">✕</button>
      </div>
    </div>
    <iframe id="doc-frame" src="about:blank"></iframe>
  </div>
</div>

<style>
  /* full-bleed on the apply page so the answers fill the viewport — the header
     bar reads the same token, so it stays aligned with the content */
  body:has(.apply-answers-full) { --page-max: none; }
  main.container:has(.apply-answers-full) { padding-left: 32px; padding-right: 32px; }
  .app-header:has(~ main .apply-answers-full) .bar { padding-left: 32px; padding-right: 32px; }
  .apply-answers-full { max-width: none; }
  .apply-answers-full p, .apply-answers-full li { max-width: 90ch; }
  .apply-answers-full pre, .apply-answers-full .md-table { max-width: 100%; }
  .doc-bar { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 20px 0; }
  .doc-group { display: inline-flex; align-items: stretch; gap: 0; }
  .doc-btn {
    background: var(--accent); color: var(--accent-ink); border: 0; padding: 8px 14px;
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    border-radius: 8px 0 0 8px;
  }
  .doc-btn:hover:not(.disabled) { opacity: .92; }
  .doc-btn.disabled { background: var(--neutral-bg); color: var(--muted); cursor: not-allowed; border-radius: 8px; }
  .doc-btn-secondary {
    background: var(--accent-weak); color: var(--accent); padding: 8px 10px; font-size: 13px;
    text-decoration: none; border-radius: 0 8px 8px 0;
    display: inline-flex; align-items: center;
  }
  .doc-btn-secondary:hover { filter: brightness(.97); }
  .doc-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    z-index: 1000; padding: 24px;
  }
  .doc-overlay.open { display: flex; align-items: stretch; justify-content: center; }
  .doc-overlay-inner {
    background: var(--surface); width: 100%; max-width: 1100px;
    display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
    box-shadow: 0 12px 48px rgba(0,0,0,0.4);
  }
  .doc-overlay-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 11px 16px; background: var(--canvas); color: var(--ink); border-bottom: 1px solid var(--border);
  }
  .doc-overlay-head #doc-title { font-weight: 700; font-size: 14px; }
  .doc-overlay-actions { display: flex; gap: 12px; align-items: center; }
  .doc-overlay-actions a { color: var(--accent); font-size: 12px; text-decoration: none; }
  .doc-overlay-actions a:hover { text-decoration: underline; }
  .doc-close {
    background: transparent; color: var(--muted); border: 0; font-size: 18px; cursor: pointer;
    line-height: 1; padding: 4px 8px;
  }
  .doc-close:hover { background: var(--row-hover); border-radius: 6px; }
  #doc-frame { flex: 1; border: 0; background: #525659; min-height: 0; }
</style>

<script>
function openDoc(url, label) {
  const overlay = document.getElementById('doc-overlay');
  const frame = document.getElementById('doc-frame');
  const title = document.getElementById('doc-title');
  const openTab = document.getElementById('doc-open-tab');
  title.textContent = label;
  openTab.href = url;
  frame.src = url + '#view=FitH';
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeDoc() {
  const overlay = document.getElementById('doc-overlay');
  const frame = document.getElementById('doc-frame');
  overlay.classList.remove('open');
  frame.src = 'about:blank';
  document.body.style.overflow = '';
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDoc();
});
</script>
`;
  return { status: 200, body: shell(`Apply Pack #${num}`, body) };
}

// Stream a PDF from output/ with strict filename safety.
function serveOutputPdf(query, res) {
  const file = String(query.file || '').trim();
  // Allow one folder level (output/<per-job folder>/<file>.pdf) but no "..":
  // dots are legal inside a segment, so traversal is rejected explicitly and
  // the resolved path is re-checked against the output directory below.
  if (!/^(?:[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+\.pdf$/.test(file) || file.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid file');
    return;
  }
  const outDir = join(ROOT, 'output');
  const abs = join(outDir, file);
  if (!abs.startsWith(outDir + '/')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid file');
    return;
  }
  if (!existsSync(abs)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const stat = statSync(abs);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${file.slice(file.lastIndexOf('/') + 1)}"`,
    'Cache-Control': 'no-cache',
  });
  createReadStream(abs).pipe(res);
}

// ----- views -----

function renderPipeline(query) {
  const path = join(ROOT, 'data', 'applications.md');
  if (!existsSync(path)) {
    return shell('Pipeline', '<h1>Pipeline</h1><div class="empty">Nothing in your pipeline yet — send a lead over from the Inbox.</div>', { view: 'pipeline', ...getCounts(), wide: true });
  }
  const text = readFileSync(path, 'utf8');
  const { header, rows } = parseApplicationsMd(text);
  const idx = {
    num: header.findIndex(h => h.trim() === '#'),
    date: header.findIndex(h => /^date$/i.test(h)),
    company: header.findIndex(h => /^company$/i.test(h)),
    role: header.findIndex(h => /^role$/i.test(h)),
    score: header.findIndex(h => /^score$/i.test(h)),
    status: header.findIndex(h => /^status$/i.test(h)),
    report: header.findIndex(h => /^report$/i.test(h)),
    notes: header.findIndex(h => /^notes$/i.test(h)),
  };

  const reportLinkRe = /\[([^\]]+)\]\(([^)]+)\)/;
  const scanHistory = loadScanHistory();
  // "New" = rows added to the pipeline on the most recent date present, but only
  // while that batch is still fresh (≤ 2 days old) — stale batches lose the tag.
  const addedDates = rows.map(r => (r[idx.date] || '').trim()).filter(Boolean).sort();
  const latestAdded = addedDates.length ? addedDates[addedDates.length - 1] : '';
  const newIsFresh = withinDays(latestAdded, 2);
  const newCount = newIsFresh ? rows.filter(r => (r[idx.date] || '').trim() === latestAdded).length : 0;

  // Display columns (forward funnel). Rejected gets its own collapsible leftmost
  // column; the quieter Discarded/SKIP states live in the bottom lane.
  // Inside Rejected, the roles that actually interviewed him are pinned to the
  // top under their own heading — a company that met you and passed is a warmer
  // lead than one that never replied. Display-only: the status stays 'Rejected'.
  const INTERVIEWED_REJECTED = 'Interviewed - Rejected';
  const REJECTED_COL = { key: 'Rejected', dot: '#B4534B', statuses: ['Rejected', INTERVIEWED_REJECTED] };
  const COLS = [
    REJECTED_COL,
    // Shortlisted + Evaluated share one column: both are "pulled into the pipeline,
    // under review, not yet applied" — the same stage from the user's POV.
    { key: 'Shortlisted', dot: '#C99A2E',       statuses: ['Shortlisted', 'Evaluated'] },
    { key: 'Applied',     dot: 'var(--accent)', statuses: ['Applied', 'Responded'] },
    { key: 'Interview',   dot: '#8B5CF6',       statuses: ['Interview'] },
    { key: 'Offer',       dot: '#3A6B45',       statuses: ['Offer'] },
  ];
  const CLOSED = ['Discarded', 'SKIP'];
  const colOf = (status) => {
    if (status === 'Evaluated') return 'Shortlisted';
    if (status === 'Responded') return 'Applied';
    if (status === INTERVIEWED_REJECTED) return 'Rejected';
    if (CLOSED.includes(status)) return 'Closed';
    if (COLS.some(c => c.key === status)) return status;
    return 'Shortlisted';
  };

  const card = (r) => {
    const num = escapeHtml(r[idx.num] || '');
    const company = escapeHtml(r[idx.company] || '');
    const role = escapeHtml(r[idx.role] || '');
    const date = escapeHtml(r[idx.date] || '');
    const scoreRaw = r[idx.score] || '';
    const note = r[idx.notes] || '';
    const rawStatus = (r[idx.status] || '').trim();
    const status = CANONICAL_STATUSES.has(rawStatus) ? rawStatus : 'Evaluated';
    const closed = CLOSED.includes(status);
    const isNew = newIsFresh && (r[idx.date] || '').trim() === latestAdded;

    let reportFile = '';
    const m = (r[idx.report] || '').match(reportLinkRe);
    if (m && /^reports\/[\w.\-]+\.md$/.test(m[2])) reportFile = m[2];
    const url = reportFile ? extractReportUrl(reportFile) : '';
    const datePosted = url ? (scanHistory.get(url) || '') : '';
    const packPath = findApplyPackForRow(r[idx.num] || '');
    const searchStr = escapeHtml((company + ' ' + role + ' ' + note).toLowerCase());

    const applyItem = url ? `<button onclick="applyJob('${escapeHtml(url)}', this)">⚡&nbsp; Apply (open terminal)</button>` : '';
    const reportItem = reportFile ? `<a href="/report?file=${encodeURIComponent(reportFile)}" data-report-file="${escapeHtml(reportFile)}" data-report-title="${escapeHtml(r[idx.company] + ' — ' + r[idx.role])}">📄&nbsp; View report</a>` : '';
    const openItem = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">↗&nbsp; Open posting</a>` : '';
    const packItem = packPath ? `<a href="/apply?row=${encodeURIComponent(r[idx.num] || '')}">📎&nbsp; Apply pack</a>` : '';
    const delItem = `<button class="danger" onclick="deleteRow('${num}', this)">🗑&nbsp; Delete</button>`;
    const topItems = [applyItem, reportItem, openItem, packItem].filter(Boolean).join('');
    const menuInner = topItems ? `${topItems}<div class="sep"></div>${delItem}` : delItem;
    const showApply = url && (status === 'Evaluated' || status === 'Shortlisted');
    const applyBtn = showApply ? `<button class="btn-apply" onclick="applyJob('${escapeHtml(url)}', this)">Apply</button>` : '';

    const addedRaw = (r[idx.date] || '').trim();
    const metaBit = addedRaw
      ? `<span class="kmeta" data-rel="${escapeHtml(addedRaw)}" title="Added to pipeline ${escapeHtml(addedRaw)}">${escapeHtml(addedRaw)}</span>`
      : (datePosted ? `<span class="kmeta" data-rel="${escapeHtml(datePosted)}">${escapeHtml(datePosted)}</span>` : '');

    return `<div class="kc${closed ? ' closed' : ''}${isNew ? ' is-new' : ''}" draggable="true" data-num="${num}" data-status="${escapeHtml(status)}"${url ? ` data-url="${escapeHtml(url)}"` : ''} data-new="${isNew ? '1' : ''}" data-search="${searchStr}">
      <div class="kc-top">
        <div><div class="co">${company}${isNew ? ' <span class="new-badge">NEW</span>' : ''}</div><div class="ro">${role}</div></div>
        <div class="menu"><button class="icon-btn" title="Actions" style="width:28px;height:28px;font-size:13px" onclick="toggleMenu(event, this)">⋯</button><div class="menu-pop">${menuInner}</div></div>
      </div>
      ${note ? `<div class="kc-note" style="font-size:11.5px;color:var(--muted);margin-top:7px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(note)}</div>` : ''}
      <div class="foot"><span class="score-mini ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw || '—')}</span>${metaBit}${applyBtn ? `<span style="margin-left:auto">${applyBtn}</span>` : ''}</div>
    </div>`;
  };

  const columnsHtml = COLS.map(c => {
    const cards = rows.filter(r => colOf(CANONICAL_STATUSES.has((r[idx.status] || '').trim()) ? (r[idx.status] || '').trim() : 'Evaluated') === c.key);
    const inner = cards.length
      ? cards.map(card).join('')
      : `<div class="kc-empty">${c.key === 'Offer' ? 'Your next milestone' : 'Nothing here yet'}</div>`;
    // The Rejected column is the collapsible leftmost rail — its header is a
    // toggle (chevron), and it carries a distinct class so JS/CSS can fold it.
    if (c.key === 'Rejected') {
      const peek = cards.length
        ? `<div class="rej-peek" role="button" tabindex="0" title="Show rejected roles"><div class="rej-peek-ghost"></div><div class="rej-peek-cap">click to show</div></div>`
        : '';
      // Compact hover-preview of the hidden roles (fades in; doesn't reflow the board).
      const MAX_PV = 5;
      const pvRows = cards.slice(0, MAX_PV).map(r => {
        const scoreRaw = r[idx.score] || '';
        return `<div class="rej-pv-row"><span class="score-mini ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw || '—')}</span><span class="rej-pv-txt"><b>${escapeHtml(r[idx.company] || '')}</b> · ${escapeHtml(r[idx.role] || '')}</span></div>`;
      }).join('');
      const pvMore = cards.length > MAX_PV ? `<div class="rej-pv-more">+${cards.length - MAX_PV} more</div>` : '';
      const preview = cards.length ? `<div class="rej-preview" aria-hidden="true">${pvRows}${pvMore}</div>` : '';
      // Split the rail by status: interviewed-then-rejected on top. Each half is
      // its own drop zone, so dragging a card into (or between) them is what
      // sets the status — no separate picker needed. Both halves always render,
      // including when empty, otherwise there would be nowhere to drop.
      const statusOf = (r) => (r[idx.status] || '').trim();
      const interviewed = cards.filter(r => statusOf(r) === INTERVIEWED_REJECTED);
      const coldRejected = cards.filter(r => statusOf(r) !== INTERVIEWED_REJECTED);
      const section = (label, status, list, key, warm) => {
        const bodyInner = list.length
          ? list.map(card).join('')
          : `<div class="kc-empty">Drag a card here</div>`;
        return `<div class="rej-sec" data-status="${escapeHtml(status)}" data-statuses="${escapeHtml(status)}">
          <div class="rej-sec-h${warm ? ' rej-sec-warm' : ''}" role="button" tabindex="0" data-seckey="${key}" title="Show/hide these">
            <span class="sec-chev">▾</span>${label}<span class="rej-sec-c">${list.length}</span>
          </div>
          <div class="rej-sec-body">${bodyInner}</div>
        </div>`;
      };
      const body = section('Interviewed', INTERVIEWED_REJECTED, interviewed, 'interviewed', true)
        + section('No interview', 'Rejected', coldRejected, 'cold', false);
      return `<div class="col col-rejected" data-status="Rejected" data-statuses="${c.statuses.join(',')}"><div class="col-h col-h-toggle" role="button" tabindex="0" title="Show/hide rejected roles"><span><span class="chev">▸</span><span class="dot" style="background:${c.dot}"></span>${c.key}</span><span class="c">${cards.length}</span></div>${peek}${preview}<div class="col-body">${body}</div></div>`;
    }
    return `<div class="col" data-status="${c.statuses[0]}" data-statuses="${c.statuses.join(',')}"><div class="col-h"><span><span class="dot" style="background:${c.dot}"></span>${c.key}</span><span class="c">${cards.length}</span></div>${inner}</div>`;
  }).join('');

  const closedCards = rows.filter(r => CLOSED.includes((r[idx.status] || '').trim()));
  const closedInner = closedCards.length
    ? `<div class="closed-grid">${closedCards.map(card).join('')}</div>`
    : `<div class="kc-empty" style="margin-top:8px">Drag a card here to mark it closed</div>`;
  const closedSummary = closedCards.length
    ? `Closed — ${closedCards.length} (discarded / skipped) · drag a card here to close it`
    : 'Closed · drag a card here to close it';
  const closedHtml = `<details class="closed-lane" data-status="Discarded" data-statuses="${CLOSED.join(',')}"${closedCards.length ? '' : ' open'}><summary>${closedSummary}</summary>${closedInner}</details>`;

  const body = `
<div class="toolbar">
  <div>
    <h1>Pipeline</h1>
    <div class="sub">Everything you're actively pursuing, by stage. Drag a card between columns to move it forward — or click it to open the posting.</div>
  </div>
  <div class="tools">
    ${newCount > 0 ? `<button class="chip-toggle" id="new-toggle" title="Added to your pipeline on the latest date (${escapeHtml(latestAdded)})">New<span class="chip-count">${newCount}</span></button>` : ''}
    <button class="btn-add-toggle" onclick="document.getElementById('add-form').classList.toggle('open')">+ Add role</button>
  </div>
</div>
<form id="add-form" class="add-form" onsubmit="return submitAddPosting(event)">
  <div class="add-row">
    <input type="url" name="url" placeholder="Job URL (required)" required style="flex:2;min-width:280px">
    <input type="text" name="company" placeholder="Company" required style="flex:1;min-width:140px">
  </div>
  <div class="add-row">
    <input type="text" name="role" placeholder="Role title" required style="flex:2;min-width:240px">
    <input type="text" name="score" placeholder="Score (e.g. 4.0)" value="4.0" style="flex:0 0 110px">
  </div>
  <div class="add-row">
    <input type="text" name="note" placeholder="Optional note (location, source, comp, etc.)" style="flex:1">
    <button type="submit" class="btn-shortlist">Add to pipeline</button>
  </div>
  <div class="muted" style="font-size:12px;margin-top:6px">Lands in <strong>Shortlisted</strong>. No evaluation runs — open the card's ⋯ menu and hit <strong>Apply</strong> later to trigger the full A–G report.</div>
</form>
<div class="board">${columnsHtml}</div>
${closedHtml}
<script>
function submitAddPosting(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    url: f.url.value.trim(),
    company: f.company.value.trim(),
    role: f.role.value.trim(),
    score: f.score.value.trim() || '4.0',
    note: f.note.value.trim(),
  };
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = '...';
  fetch('/api/shortlist', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(j => {
    if (j.ok && j.noChange) { showToast('Already in pipeline'); btn.disabled = false; btn.textContent = 'Add to pipeline'; }
    else if (j.ok) { showToast('Added #' + j.num); setTimeout(() => location.reload(), 600); }
    else { btn.disabled = false; btn.textContent = 'Add to pipeline'; showToast('Add failed: ' + (j.error || 'unknown'), true); }
  }).catch(err => { btn.disabled = false; btn.textContent = 'Add to pipeline'; showToast(err.message, true); });
  return false;
}
(function(){
  const s = document.getElementById('global-search');
  const newToggle = document.getElementById('new-toggle');
  const cards = Array.from(document.querySelectorAll('.kc'));
  let term = '', newOnly = false;
  function apply() {
    cards.forEach(c => {
      const okSearch = !term || (c.dataset.search || '').indexOf(term) >= 0;
      const okNew = !newOnly || c.dataset.new === '1';
      c.style.display = (okSearch && okNew) ? '' : 'none';
    });
  }
  if (s) s.addEventListener('input', () => { term = s.value.trim().toLowerCase(); apply(); });
  if (newToggle) newToggle.addEventListener('click', () => { newOnly = !newOnly; newToggle.classList.toggle('active', newOnly); apply(); });
  if (newToggle && new URLSearchParams(location.search).get('new') === '1') { newOnly = true; newToggle.classList.add('active'); apply(); }
})();
// ----- drag-and-drop between columns + click-to-open-posting -----
(function(){
  let dragNum = null, dragged = null, didDrag = false;
  const dropZones = document.querySelectorAll('[data-statuses]');
  document.querySelectorAll('.kc[draggable]').forEach(c => {
    c.addEventListener('dragstart', e => {
      dragNum = c.dataset.num; dragged = c; didDrag = true;
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragNum); } catch (_) {}
      const lane = document.querySelector('.closed-lane'); if (lane) lane.open = true;
      const rej = document.querySelector('.col-rejected'); if (rej) rej.classList.remove('collapsed');
    });
    c.addEventListener('dragend', () => {
      c.classList.remove('dragging');
      dropZones.forEach(t => t.classList.remove('drop-target'));
      dragNum = null; dragged = null;
      setTimeout(() => { didDrag = false; }, 30);
    });
    c.addEventListener('click', e => {
      if (didDrag) return;
      if (e.target.closest('.menu') || e.target.closest('a') || e.target.closest('button')) return;
      if (c.dataset.url) window.open(c.dataset.url, '_blank', 'noopener');
    });
  });
  dropZones.forEach(t => {
    // stopPropagation: the Rejected subsections are drop zones nested inside the
    // column, which is one too. Without this both fire and the outer one wins,
    // so every drop would land in plain Rejected.
    t.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; t.classList.add('drop-target'); });
    t.addEventListener('dragleave', e => { if (!t.contains(e.relatedTarget)) t.classList.remove('drop-target'); });
    t.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      t.classList.remove('drop-target');
      if (!dragNum || !dragged) return;
      const status = t.dataset.status;
      if (!status) return;
      if ((t.dataset.statuses || '').split(',').includes(dragged.dataset.status)) return; // already in this lane
      fetch('/api/set-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num: dragNum, status })
      }).then(r => r.json()).then(j => {
        if (!j.ok) { showToast('Move failed: ' + (j.error || 'unknown'), true); return; }
        showToast('Moved to ' + status);
        setTimeout(() => location.reload(), 350);
      }).catch(err => showToast(err.message, true));
    });
  });
})();
// ----- collapsible Rejected column (persists; collapsed by default) -----
(function(){
  const col = document.querySelector('.col-rejected');
  if (!col) return;
  const KEY = 'getthejob-rejected-collapsed';
  const stored = localStorage.getItem(KEY);
  // Default to collapsed so rejections stay tucked away; header is always visible.
  if (stored === null || stored === '1') col.classList.add('collapsed');
  const header = col.querySelector('.col-h-toggle');
  function toggle(){
    const collapsed = col.classList.toggle('collapsed');
    localStorage.setItem(KEY, collapsed ? '1' : '0');
  }
  const targets = [header, col.querySelector('.rej-peek')].filter(Boolean);
  targets.forEach(t => {
    t.addEventListener('click', toggle);
    t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });

  // Each subsection folds independently, and remembers.
  col.querySelectorAll('.rej-sec-h[data-seckey]').forEach(h => {
    const sec = h.closest('.rej-sec');
    const secKey = 'getthejob-rejsec-' + h.dataset.seckey;
    if (localStorage.getItem(secKey) === '1') sec.classList.add('sec-collapsed');
    const toggleSec = (e) => {
      if (e) e.stopPropagation();
      const isCollapsed = sec.classList.toggle('sec-collapsed');
      localStorage.setItem(secKey, isCollapsed ? '1' : '0');
    };
    h.addEventListener('click', toggleSec);
    h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSec(e); } });
  });
})();
</script>
`;
  return shell('Pipeline', body, { view: 'pipeline', ...getCounts(), wide: true });
}

function renderReport(query) {
  const file = query.file || '';
  // path-traversal guard
  if (!/^reports\/[\w.\-]+\.md$/.test(file)) {
    return { status: 400, body: shell('Bad request', '<h1>Bad request</h1><p>Invalid report path.</p><p><a href="/?view=pipeline">← Back</a></p>') };
  }
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    return { status: 404, body: shell('Not found', '<h1>Not found</h1><p>Report does not exist.</p><p><a href="/?view=pipeline">← Back</a></p>') };
  }
  const md = readFileSync(abs, 'utf8');
  const html = renderMarkdown(md);
  const body = `
<p><a href="/?view=pipeline">← Back</a></p>
<article class="report-body">${html}</article>
`;
  return { status: 200, body: shell(file, body) };
}

// Extract a USD pay range from a triage note. Returns {display, sortKey}.
// sortKey is the upper bound of the range in $K, used for sorting rows; 0 means unknown.
// Notes use varied formats: "$139K–$287K", "$240-300K", "305-385K", "240-320K in band".
// The K suffix is required to avoid matching year ranges ("2025-03-26") or experience
// ranges ("8-12 yrs"). Sanity check: lo >= 50, hi <= 800.
function extractComp(note) {
  if (!note) return { display: '', sortKey: 0 };
  const re = /(?:\$\s*)?(\d{2,3})\s*K?\s*[-–—]\s*(?:\$\s*)?(\d{2,3})\s*K\b/gi;
  let m;
  while ((m = re.exec(note)) !== null) {
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    if (lo >= 50 && hi <= 800 && hi >= lo) {
      return { display: `$${lo}–${hi}K`, sortKey: hi };
    }
  }
  // Single-bound thresholds: "below $200K", "<$200K", ">$300K"
  const low = note.match(/(?:below|under|<|≤)\s*\$?\s*(\d{2,3})\s*K\b/i);
  if (low) {
    const n = parseInt(low[1], 10);
    if (n >= 50 && n <= 800) return { display: `<$${n}K`, sortKey: n };
  }
  const high = note.match(/(?:above|over|>|≥)\s*\$?\s*(\d{2,3})\s*K\b/i);
  if (high) {
    const n = parseInt(high[1], 10);
    if (n >= 50 && n <= 800) return { display: `>$${n}K`, sortKey: n };
  }
  if (/not disclosed|undisclosed|comp not stated|no comp\b/i.test(note)) {
    return { display: 'Not disclosed', sortKey: 0 };
  }
  return { display: '', sortKey: 0 };
}

// Collapse the many spellings of a remote location into one canonical bucket so
// the Location filter shows a single "Remote (US)" option instead of "Remote US",
// "Remote, US", "Remote - US", "US Remote", "United States (remote)", etc. Cards
// still display the raw string; only the filter grouping is normalized.
// Non-remote or unrecognized values pass through unchanged (one option each).
function locationGroup(raw) {
  const s = (raw || '').trim();
  if (!s) return '';                       // empty → "Unknown"
  const low = s.toLowerCase();
  if (!/remote/.test(low)) return s;       // on-site/hybrid → keep as-is
  // Region detected alongside "remote". US is checked first so combos that list
  // US cities + "Remote US" (and the "Remote East/West" coast shorthand) group as US.
  if (/\b(u\.?s\.?a?|united states)\b/.test(low) || /remote\s*(east|west)\b/.test(low)) return 'Remote (US)';
  if (/canada|toronto|vancouver|montreal/.test(low)) return 'Remote (Canada)';
  if (/\b(uk|united kingdom|england|scotland|wales|london)\b/.test(low)) return 'Remote (UK)';
  if (/ireland/.test(low)) return 'Remote (Ireland)';
  if (/sweden/.test(low)) return 'Remote (Sweden)';
  if (/spain/.test(low)) return 'Remote (Spain)';
  if (/germany/.test(low)) return 'Remote (Germany)';
  if (/\b(eu|europe)\b/.test(low)) return 'Remote (EU)';
  return 'Remote';                         // remote, region unspecified
}

// Build a url→first_seen map from scan-history.tsv. Used as a proxy for
// "Date Posted" — typically within 0–3 days of the actual posting.
function loadScanHistory() {
  const path = join(ROOT, 'data', 'scan-history.tsv');
  const map = new Map();
  if (!existsSync(path)) return map;
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split('\t');
    const url = cells[0];
    const firstSeen = cells[1];
    if (url && firstSeen && !map.has(url)) map.set(url, firstSeen);
  }
  return map;
}

// URLs already in the pipeline (applications.md), pulled from the **URL:** header
// of each linked report. Used to hide Inbox leads that have already been
// shortlisted/evaluated/applied so they don't re-surface with a stale triage score.
function loadPipelineUrls() {
  const set = new Set();
  try {
    const trackerPath = join(ROOT, 'data', 'applications.md');
    if (!existsSync(trackerPath)) return set;
    const existing = readFileSync(trackerPath, 'utf8');
    const reportPaths = Array.from(existing.matchAll(/reports\/[\w.\-]+\.md/g)).map(m => m[0]);
    for (const rp of new Set(reportPaths)) {
      const u = extractReportUrl(rp);
      if (u) set.add(u);
    }
  } catch {}
  return set;
}

// URLs known to be expired/closed, recorded by the liveness sweep in
// batch/expired-urls.txt. Used to drop dead postings from the Inbox immediately,
// so removal doesn't wait for the next job search to sweep triage-scores.tsv.
// Each line is either a bare URL or "URL<TAB>date<TAB>note"; the URL is column 0.
function loadExpiredUrls() {
  const set = new Set();
  try {
    const path = join(ROOT, 'batch', 'expired-urls.txt');
    if (!existsSync(path)) return set;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const url = (line.split('\t')[0] || '').trim();
      if (url) set.add(url);
    }
  } catch {}
  return set;
}

function getCounts() {
  let inbox = null, pipeline = null;
  try {
    const p = join(ROOT, 'data', 'triage-scores.tsv');
    if (existsSync(p)) {
      const { header, rows } = parseTsv(readFileSync(p, 'utf8'));
      const urlIdx = header.findIndex(h => /^url$/i.test(h));
      const pipeUrls = loadPipelineUrls();
      const expiredUrls = loadExpiredUrls();
      inbox = rows.filter(r => {
        const u = (urlIdx >= 0 ? r[urlIdx] : '') || '';
        return !pipeUrls.has(u) && !expiredUrls.has(u);
      }).length;
    }
  } catch {}
  try { const p = join(ROOT, 'data', 'applications.md'); if (existsSync(p)) pipeline = parseApplicationsMd(readFileSync(p, 'utf8')).rows.length; } catch {}
  return { inbox, pipeline };
}

// ----- Scoring guardrails: hard exclusions vs soft penalties in _profile.md ----
// Match any "## …Deal-Breaker…" / "## …Guardrail…" heading (hand-curated profiles
// use variants). Within it the editor owns a marked region with two lists: HARD
// (auto-skip, score 1.0) and SOFT (lower the score, still shown). Markers are HTML
// comments so anything the user wrote outside them is left untouched.
const GUARD_HEADING_RE = /^##\s+.*(guardrail|deal-?breaker)/i;
const RULES_START = '<!-- gtj:rules:start -->';
const RULES_END = '<!-- gtj:rules:end -->';

// Strip markdown emphasis/backticks so rules read as clean prose in the editor.
function cleanRuleText(s) {
  return String(s).replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

// Guess whether a legacy flat rule is hard (exclude) or soft (weight down) from
// its wording. Only used to seed the split the first time; the user can re-sort.
function classifyRule(text) {
  const t = text.toLowerCase();
  const hardSig = /\bhard no\b|auto-?skip|\bexclude\b|out of range|\bnever\b|hard exclusion|\bskip\b/.test(t);
  const softSig = /\bflag\b|discourage|penal|weigh|lower the score|score down|not a deal-?breaker|\bprefer\b|≤|\bsoft\b/.test(t);
  return (softSig && !hardSig) ? 'soft' : 'hard';
}

function parseHardSoft(block) {
  const hard = [], soft = [];
  let cur = null;
  for (const l of block.split('\n')) {
    if (/^###\s+.*hard/i.test(l)) { cur = hard; continue; }
    if (/^###\s+.*soft/i.test(l)) { cur = soft; continue; }
    const m = l.match(/^\s*-\s+(.*)$/);
    if (m && cur) { const it = m[1].trim(); if (it && !/^_.*_$/.test(it)) cur.push(cleanRuleText(it)); }
  }
  return { hard, soft };
}

function managedBlock(hard, soft) {
  const list = arr => arr.length ? arr.map(s => '- ' + s).join('\n') : '_None yet._';
  return RULES_START + '\n\n'
    + '### Hard exclusions — auto-skip (score 1.0, never shown as a match)\n\n' + list(hard) + '\n\n'
    + '### Soft penalties — lower the score, but the posting still appears\n\n' + list(soft) + '\n\n'
    + RULES_END;
}

// Returns { exists, hard:[], soft:[] }. Prefers the marked region; falls back to
// ### Hard/### Soft subsections; finally treats a legacy flat bullet list as HARD.
function readGuardrails() {
  const p = join(ROOT, 'modes', '_profile.md');
  if (!existsSync(p)) return { exists: false, hard: [], soft: [] };
  const text = readFileSync(p, 'utf8');
  const s = text.indexOf(RULES_START), e = text.indexOf(RULES_END);
  if (s >= 0 && e > s) return { exists: true, ...parseHardSoft(text.slice(s, e)) };
  const lines = text.split('\n');
  const hIdx = lines.findIndex(l => GUARD_HEADING_RE.test(l));
  if (hIdx < 0) return { exists: true, hard: [], soft: [] };
  let secEnd = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) { if (lines[i].startsWith('## ')) { secEnd = i; break; } }
  const section = lines.slice(hIdx, secEnd).join('\n');
  if (/###\s+.*(hard|soft)/i.test(section)) return { exists: true, ...parseHardSoft(section) };
  // Legacy flat list: clean each rule and auto-split hard vs soft by its wording.
  const hard = [], soft = [];
  for (let i = hIdx + 1; i < secEnd; i++) {
    const m = lines[i].match(/^\s*-\s+(.*)$/);
    if (m) {
      const raw = m[1].trim();
      if (raw && !/^_.*_$/.test(raw)) {
        const it = cleanRuleText(raw);
        (classifyRule(it) === 'soft' ? soft : hard).push(it);
      }
    }
  }
  return { exists: true, hard, soft };
}

// Writes the marked region into the guardrail section, preserving the heading and
// any surrounding prose/notes. Migrates a legacy flat list (replaces those bullets
// with the marked region). Creates the section/file when missing.
function writeGuardrails(hard, soft) {
  const dir = join(ROOT, 'modes');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, '_profile.md');
  const H = (hard || []).map(s => String(s).trim()).filter(Boolean);
  const S = (soft || []).map(s => String(s).trim()).filter(Boolean);
  const block = managedBlock(H, S);

  let text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (!text.trim()) {
    writeFileSync(p, '# User Profile Context — get-the-job\n\n## Your Guardrails / Deal-Breakers\n\n' + block + '\n');
    return { hard: H.length, soft: S.length };
  }
  const s = text.indexOf(RULES_START), e = text.indexOf(RULES_END);
  if (s >= 0 && e > s) {
    writeFileSync(p, text.slice(0, s) + block + text.slice(e + RULES_END.length));
    return { hard: H.length, soft: S.length };
  }
  const lines = text.split('\n');
  const hIdx = lines.findIndex(l => GUARD_HEADING_RE.test(l));
  if (hIdx < 0) {
    writeFileSync(p, text.replace(/\s*$/, '') + '\n\n## Your Guardrails / Deal-Breakers\n\n' + block + '\n');
    return { hard: H.length, soft: S.length };
  }
  let secEnd = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) { if (lines[i].startsWith('## ')) { secEnd = i; break; } }
  let bStart = -1, bEnd = -1;
  for (let i = hIdx + 1; i < secEnd; i++) { if (/^\s*-\s+/.test(lines[i])) { if (bStart < 0) bStart = i; bEnd = i; } else if (bStart >= 0) break; }
  const out = bStart >= 0
    ? lines.slice(0, bStart).concat(block.split('\n'), lines.slice(bEnd + 1))
    : lines.slice(0, hIdx + 1).concat('', block.split('\n'), lines.slice(hIdx + 1));
  writeFileSync(p, out.join('\n'));
  return { hard: H.length, soft: S.length };
}

// Inbox UI snippet: the "Scoring rules" toggle button + the editor panel.
function guardrailsUI() {
  return `<button id="rules-toggle" class="btn-rules" aria-expanded="false" aria-controls="guardrails-panel" onclick="toggleGuardrails()" title="Hard exclusions and soft penalties applied when postings are scored">⚖<span>Scoring rules</span><span class="caret">▾</span></button>`;
}
function guardrailsPanel(open) {
  return `<div id="guardrails-panel" class="rules-panel${open ? ' open' : ''}">
  <div class="rules-cols">
    <div>
      <div class="rules-group-h"><span class="rg-badge hard">Hard</span> Exclude entirely <span class="rg-sub">— auto-skip, never shown</span></div>
      <div id="guard-hard" class="rule-list"></div>
      <button type="button" class="btn-add-row" onclick="addRuleRow('hard','',true)">+ Add hard exclusion</button>
    </div>
    <div>
      <div class="rules-group-h"><span class="rg-badge soft">Soft</span> Weight the score down <span class="rg-sub">— still shown, ranked lower</span></div>
      <div id="guard-soft" class="rule-list"></div>
      <button type="button" class="btn-add-row" onclick="addRuleRow('soft','',true)">+ Add soft penalty</button>
    </div>
  </div>
  <div class="rules-actions">
    <button type="button" class="btn-save" id="guardrails-save" onclick="saveGuardrails(this)">Save</button>
    <span id="guardrails-msg" class="muted"></span>
  </div>
</div>`;
}

// Settings page: shows the user's current setup and lets them edit scoring rules
// inline. Profile basics are changed by re-running the wizard or editing files.
function renderSettings() {
  let prof = {};
  try {
    const p = join(ROOT, 'config', 'profile.yml');
    if (existsSync(p)) prof = yaml.load(readFileSync(p, 'utf8')) || {};
  } catch { /* show what we can */ }
  const cand = prof.candidate || {};
  const roles = (prof.target_roles && prof.target_roles.primary) || [];
  const comp = prof.compensation || {};
  let companyCount = 0;
  try {
    const pp = join(ROOT, 'portals.yml');
    if (existsSync(pp)) { const py = yaml.load(readFileSync(pp, 'utf8')) || {}; companyCount = (py.tracked_companies || []).length; }
  } catch { /* ignore */ }

  const row = (label, val) => val ? `<div class="set-row"><span class="set-k">${escapeHtml(label)}</span><span class="set-v">${escapeHtml(String(val))}</span></div>` : '';
  const profileCard = `<div class="set-card">
    <h3>Your profile</h3>
    ${row('Name', cand.full_name)}
    ${row('Email', cand.email)}
    ${row('Location', cand.location)}
    ${roles.length ? row('Target roles', roles.join(', ')) : ''}
    ${comp.target_range ? row('Comp target', comp.target_range + (comp.currency && !new RegExp('\\b' + String(comp.currency).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(comp.target_range) ? ' ' + comp.currency : '')) : ''}
    ${row('Companies tracked', companyCount)}
    <div style="margin-top:14px"><a class="btn-set" href="/onboarding?edit=1" onclick="return confirm('Re-running setup replaces your profile, scoring rules, tracked companies, and CV with whatever you enter next.\\n\\nA timestamped backup of your current setup is saved automatically (to backups/), but continue?');">Re-run the setup wizard →</a> <span class="muted" style="font-size:12.5px">replaces your current setup — a backup is saved automatically. Or edit <code>config/profile.yml</code>, <code>portals.yml</code>, <code>cv.md</code> directly.</span></div>
  </div>`;

  const body = `
<div class="toolbar"><div><h1>Settings</h1><div class="sub">Your setup. Scoring rules are editable here; change profile basics by re-running the wizard.</div></div></div>
${profileCard}
<h3 style="margin:22px 0 4px">Scoring rules</h3>
<div class="muted" style="margin:0 0 12px;font-size:13px">Read every time your postings are scored. <b>Hard</b> exclusions drop a posting; <b>soft</b> penalties just lower its score.</div>
${guardrailsPanel(true)}
<script>document.addEventListener('DOMContentLoaded', function(){ loadGuardrails(); });</script>
`;
  return shell('Settings', body, { ...getCounts() });
}

function renderInbox(query) {
  const path = join(ROOT, 'data', 'triage-scores.tsv');
  if (!existsSync(path)) {
    return shell('Inbox',
      `<div class="toolbar"><div><h1>Inbox</h1></div></div>
<div class="stats-row">${guardrailsUI()}</div>
${guardrailsPanel()}
<div class="empty" style="line-height:1.6">No scored leads yet.<br>1. Find jobs — run a scan (<code>npm run scan</code> or the scan button).<br>2. Score them — open this project in <b>Claude Code</b> and run <code>/get-the-job triage</code>.<br>Scored postings show up here.<br><span style="font-size:12.5px">Tip: set your scoring rules above first — hard exclusions to drop postings, soft penalties to rank them down.</span></div>`,
      { view: 'inbox', ...getCounts() });
  }
  const text = readFileSync(path, 'utf8');
  const { header, rows: allRows } = parseTsv(text);
  const idx = {
    url:      header.findIndex(h => /^url$/i.test(h)),
    added:    header.findIndex(h => /^first[_ ]seen$/i.test(h)),
    score:    header.findIndex(h => /^score$/i.test(h)),
    verdict:  header.findIndex(h => /^verdict$/i.test(h)),
    company:  header.findIndex(h => /^company$/i.test(h)),
    role:     header.findIndex(h => /^role$/i.test(h)),
    note:     header.findIndex(h => /^one[_ ]line[_ ]note$/i.test(h)),
    location: header.findIndex(h => /^location$/i.test(h)),
  };

  // Hide leads already in the pipeline (shortlisted/evaluated/applied) so a job
  // that was fully evaluated doesn't re-appear here with a divergent triage score.
  // Also drop any posting already known to be expired/closed (liveness sweep).
  const pipeUrls = loadPipelineUrls();
  const expiredUrls = loadExpiredUrls();
  const rows = idx.url >= 0
    ? allRows.filter(r => !pipeUrls.has(r[idx.url] || '') && !expiredUrls.has(r[idx.url] || ''))
    : allRows;

  const scanHistory = loadScanHistory();

  const sorted = rows.slice().sort((a, b) => {
    const sa = parseFloat(a[idx.score]); const sb = parseFloat(b[idx.score]);
    if (Number.isNaN(sa) && Number.isNaN(sb)) return 0;
    if (Number.isNaN(sa)) return 1;
    if (Number.isNaN(sb)) return -1;
    return sb - sa;
  });

  // Median top-of-band pay across the leads that advertise a range.
  const tops = [];
  sorted.forEach(r => {
    const top = Number(extractComp(r[idx.note] || '').sortKey) || 0;
    if (top > 0) tops.push(top);
  });
  const medianTop = tops.length ? tops.slice().sort((a, b) => a - b)[Math.floor(tops.length / 2)] : 0;

  // "New" = leads from the most recent scan date present (i.e. today, right after
  // a batch runs), but only while that scan is still fresh (≤ 2 days old).
  const addedDates = sorted.map(r => (r[idx.added] || '').trim()).filter(Boolean).sort();
  const latestAdded = addedDates.length ? addedDates[addedDates.length - 1] : '';
  const newIsFresh = withinDays(latestAdded, 2);
  const newCount = newIsFresh ? sorted.filter(r => (r[idx.added] || '').trim() === latestAdded).length : 0;

  const leadRows = sorted.map(r => {
    const url = r[idx.url] || '';
    const scoreRaw = r[idx.score] || '';
    const scoreNum = (String(scoreRaw).match(/([0-9]+(\.[0-9]+)?)/) || [])[1] || '0';
    const verdict = r[idx.verdict] || '';
    const company = r[idx.company] || '';
    const role = r[idx.role] || '';
    const datePosted = scanHistory.get(url) || '';
    const location = idx.location >= 0 ? (r[idx.location] || '') : '';
    const locGroup = locationGroup(location);
    const note = r[idx.note] || '';
    const comp = extractComp(note);
    const firstSeen = r[idx.added] || '';
    const isNew = newIsFresh && firstSeen.trim() === latestAdded;
    const sn = parseFloat(scoreNum) || 0;
    const scoreBucket = sn >= 4.5 ? '4.5+' : sn >= 4.0 ? '4.0-4.4' : sn >= 3.5 ? '3.5-3.9' : '<3.5';
    const searchStr = escapeHtml((company + ' ' + role + ' ' + location + ' ' + note).toLowerCase());

    const skipish = /^SKIP/i.test(verdict) || /^SUSPICIOUS/i.test(verdict);
    const shortlistBtn = url
      ? `<button class="btn-shortlist"${skipish ? ' style="background:transparent;border:1px solid var(--border);color:var(--muted)"' : ''} onclick='shortlistJob(${JSON.stringify({ url, company, role, score: scoreRaw, note }).replace(/'/g, "&apos;")}, this)' title="Move to Pipeline as Shortlisted (no evaluation yet)">→ Pipeline</button>`
      : '';
    const metaDate = firstSeen.trim() || datePosted;
    const meta = [
      location ? `<span>${escapeHtml(location)}</span>` : '',
      comp.display ? `<span>${escapeHtml(comp.display)}</span>` : '',
      metaDate ? `<span data-rel="${escapeHtml(metaDate)}" title="Added to your inbox ${escapeHtml(metaDate)}">${escapeHtml(metaDate)}</span>` : '',
    ].filter(Boolean).join('');

    return `<div class="lead${isNew ? ' is-new' : ''}"${url ? ` data-url="${escapeHtml(url)}"` : ''} data-verdict="${escapeHtml(verdict)}" data-score-bucket="${scoreBucket}" data-company="${escapeHtml(company)}" data-location="${escapeHtml(locGroup)}" data-score="${escapeHtml(scoreNum)}" data-pay="${comp.sortKey}" data-posted="${escapeHtml(datePosted)}" data-added="${escapeHtml(firstSeen)}" data-new="${isNew ? '1' : ''}" data-search="${searchStr}">
      <div class="score-chip ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw || '—')}</div>
      <div class="lead-main">
        <div class="lead-co">${escapeHtml(company)}${isNew ? ' <span class="new-badge">NEW</span>' : ''}</div>
        <div class="lead-role">${escapeHtml(role)}</div>
        <div class="lead-meta">${meta}</div>
      </div>
      ${/^SUSPICIOUS/i.test(verdict) ? `<span class="lead-flag" title="Posting legitimacy unverified — check before applying">⚠ unverified</span>` : ''}
      <div class="lead-act">
        ${shortlistBtn}
        ${url ? `<button class="icon-btn icon-danger" title="Delete from inbox" onclick="dismissTriage('${escapeHtml(url)}', this)">🗑</button>` : ''}
      </div>
    </div>`;
  }).join('');

  // Collect unique filter values from the data
  const verdictOrder = ['APPLY HIGH', 'APPLY', 'APPLY (reach)', 'SKIP', 'SKIP_STALE', 'SUSPICIOUS'];
  const verdictSet = new Set();
  const locationSet = new Set();
  const companySet = new Set();
  sorted.forEach(r => {
    const v = r[idx.verdict] || '';
    if (v) verdictSet.add(v);
    const loc = locationGroup(idx.location >= 0 ? (r[idx.location] || '') : '');
    locationSet.add(loc); // include empty string for "Unknown"
    const co = r[idx.company] || '';
    if (co) companySet.add(co);
  });
  const verdicts = verdictOrder.filter(v => verdictSet.has(v));
  verdictSet.forEach(v => { if (!verdicts.includes(v)) verdicts.push(v); });
  const locations = Array.from(locationSet).filter(l => l).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (locationSet.has('')) locations.push(''); // "Unknown" last

  const scoreBuckets = ['4.5+', '4.0-4.4', '3.5-3.9', '<3.5'];

  // Build dropdown option HTML for each filterable column (count placeholder updated client-side)
  const scoreOpts = scoreBuckets.map(b =>
    `<label data-opt-value="${escapeHtml(b)}"><input type="checkbox" data-value="${escapeHtml(b)}"> ${escapeHtml(b)} <span class="opt-count"></span></label>`
  ).join('');
  const companies = Array.from(companySet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const companyOpts = companies.map(c =>
    `<label data-opt-value="${escapeHtml(c)}"><input type="checkbox" data-value="${escapeHtml(c)}"> ${escapeHtml(c)} <span class="opt-count"></span></label>`
  ).join('');
  const locationOpts = locations.map(l =>
    `<label data-opt-value="${escapeHtml(l)}"><input type="checkbox" data-value="${escapeHtml(l)}"> ${l ? escapeHtml(l) : '<span class="muted">Unknown</span>'} <span class="opt-count"></span></label>`
  ).join('');

  const body = `
<div class="toolbar">
  <div>
    <h1>Inbox</h1>
    <div class="sub">Open roles the scanner found and scored against your profile. Send the strong ones to your pipeline.</div>
  </div>
</div>
<div class="stats-row">
  <div class="row-actions">
    <div id="batch-banner" class="batch-banner">
      <span id="batch-icon" class="batch-icon">⏳</span>
      <span id="batch-msg" class="batch-msg">Finding new jobs…</span>
      <span id="batch-elapsed" class="batch-elapsed"></span>
    </div>
    <button id="batch-run-btn" class="btn-batch" onclick="runBatch(this)" style="display:none" title="Scans your companies and scores new roles into your inbox. Run it daily.">🔍 Find New Jobs</button>
  </div>
  ${guardrailsUI()}
</div>
${guardrailsPanel()}
<script>
(function(){
  const banner=document.getElementById('batch-banner'),icon=document.getElementById('batch-icon'),
    msg=document.getElementById('batch-msg'),elapsed=document.getElementById('batch-elapsed'),
    runBtn=document.getElementById('batch-run-btn');
  let done=false;
  function ago(iso){
    const ms=Date.now()-new Date(iso).getTime();
    if(!isFinite(ms)||ms<0)return 'just now';
    const m=Math.floor(ms/60000);
    if(m<1)return 'just now';
    if(m<60)return m+'m ago';
    const h=Math.floor(m/60);
    if(h<24)return h+'h ago';
    const dys=Math.floor(h/24);
    return dys===1?'yesterday':dys+'d ago';
  }
  async function poll(){
    try{
      const d=await(await fetch('/api/batch-status')).json();
      let state='';
      if(d.running){
        state='is-running';icon.textContent='⏳';
        msg.textContent='Finding new jobs…';
        runBtn.style.display='none';
        if(d.started){const m=Math.floor((Date.now()-new Date(d.started).getTime())/60000);elapsed.textContent=m+'m';}
      }else{
        // Not running. Build a base message from this session's last exit (if any).
        // Copy is kept short — this sits inline next to the stats, not in a full-width bar.
        let base='',meta=false;
        if(d.exitCode===0){state='is-done';icon.textContent='✅';base='Found new jobs — <a href="/?view=inbox&new=1">see them</a>';}
        else if(d.exitCode===143||d.exitCode===137){state='';icon.textContent='⏹';base='Search stopped';}
        else if(d.exitCode!==null){state='is-failed';icon.textContent='⚠️';base='Search failed (exit '+d.exitCode+')';}
        // Nothing to report from this session — show when the last search ran.
        // (Reads better than a countdown to when the next one is allowed.)
        if(!base){icon.textContent='';if(d.lastRun){base='Last search '+ago(d.lastRun);meta=true;}}
        // The label is always the same — one button, one job. Cooldown only flips the
        // override flag, and the confirm dialog is where the 24h rule gets explained.
        runBtn.textContent='🔍 Find New Jobs';
        runBtn.dataset.override=d.cooldownActive?'1':'';
        msg.className='batch-msg'+(meta?' meta':'');
        msg.innerHTML=base;runBtn.style.display='';elapsed.textContent='';done=true;
      }
      banner.className='batch-banner show'+(state?' '+state:'');
    }catch(e){}
    if(!done)setTimeout(poll,5000);
  }
  poll();
})();
function runBatch(btn){
  const override=btn.dataset.override==='1';
  const label=btn.textContent;
  if(override&&!confirm('You already searched for new jobs in the last 24 hours. Search again now anyway?'))return;
  btn.disabled=true;btn.textContent='Starting...';
  fetch('/api/run-batch'+(override?'?override=1':''),{method:'POST'}).then(r=>r.json()).then(d=>{
    if(d.ok)location.reload();
    else{btn.disabled=false;btn.textContent=label;alert(d.error||'Could not start the job search.');}
  }).catch(()=>{btn.disabled=false;btn.textContent=label;});
}
</script>
<div class="filter-bar">
  ${newCount > 0 ? `<button class="chip-toggle" id="new-toggle" title="Leads from the latest scan (${escapeHtml(latestAdded)})">New<span class="chip-count">${newCount}</span></button>` : ''}
  <span class="col-filter" data-col="score-bucket">Score&nbsp;▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear</button>${scoreOpts}</div></span>
  <span class="col-filter" data-col="company">Company&nbsp;▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear</button>${companyOpts}</div></span>
  <span class="col-filter" data-col="location">Location&nbsp;▾<div class="col-dropdown col-dropdown-loc"><button class="col-dropdown-clear">Clear</button>${locationOpts}</div></span>
  ${medianTop ? `<span class="row-meta" title="Median of the top of each advertised pay band"><b>$${medianTop}K</b> median pay</span>` : ''}
  <span class="muted" id="inbox-summary"></span>
  <span class="sortctl">Sort <select id="inbox-sort"><option value="score-desc">Score: high → low</option><option value="score-asc">Score: low → high</option><option value="company">Company A–Z</option><option value="pay-desc">Pay: high → low</option><option value="posted-desc">Newest first</option></select></span>
</div>
<div class="panel" id="inbox-list">${leadRows || '<div class="empty">No leads in the inbox.</div>'}</div>
<script>
// Click a lead row to open its posting (ignore clicks on the buttons/menu/links).
(function() {
  const list = document.getElementById('inbox-list');
  if (!list) return;
  list.addEventListener('click', e => {
    if (e.target.closest('.menu') || e.target.closest('a') || e.target.closest('button')) return;
    const lead = e.target.closest('.lead[data-url]');
    if (lead && lead.dataset.url) window.open(lead.dataset.url, '_blank', 'noopener');
  });
})();
(function() {
  const STORAGE_KEY = 'getthejob-triage-filters';
  const filterKeys = ['score-bucket', 'company', 'location'];
  const filters = {}; filterKeys.forEach(k => filters[k] = new Set());
  const rows = Array.from(document.querySelectorAll('#inbox-list .lead'));
  const total = rows.length;
  const summary = document.getElementById('inbox-summary');
  const searchEl = document.getElementById('global-search');
  const sortSel = document.getElementById('inbox-sort');
  const panel = document.getElementById('inbox-list');
  let term = '';
  let newOnly = false;
  const newToggle = document.getElementById('new-toggle');
  const rowData = rows.map(el => ({ el, verdict: el.dataset.verdict || '', 'score-bucket': el.dataset.scoreBucket || '', company: el.dataset.company || '', location: el.dataset.location || '', search: el.dataset.search || '', isNew: el.dataset.new === '1' }));
  function passExcluding(rd, ex) { for (const k of filterKeys) { if (k === ex) continue; if (filters[k].size === 0) continue; if (!filters[k].has(rd[k])) return false; } return true; }
  function apply() {
    let shown = 0;
    rowData.forEach(rd => {
      let ok = true;
      for (const k of filterKeys) { if (filters[k].size && !filters[k].has(rd[k])) { ok = false; break; } }
      if (ok && term && rd.search.indexOf(term) < 0) ok = false;
      if (ok && newOnly && !rd.isNew) ok = false;
      rd.el.classList.toggle('is-hidden', !ok);
      if (ok) shown++;
    });
    const anyActive = filterKeys.some(k => filters[k].size > 0) || term || newOnly;
    summary.textContent = anyActive ? shown + ' of ' + total + ' shown' : '';
    document.querySelectorAll('.filter-bar .col-filter').forEach(trigger => {
      const col = trigger.dataset.col, dd = trigger.querySelector('.col-dropdown'), counts = {};
      rowData.forEach(rd => { if (passExcluding(rd, col)) counts[rd[col]] = (counts[rd[col]] || 0) + 1; });
      dd.querySelectorAll('label[data-opt-value]').forEach(l => {
        const v = l.dataset.optValue, c = counts[v] || 0, ce = l.querySelector('.opt-count');
        if (ce) ce.textContent = c > 0 ? '(' + c + ')' : '';
        l.classList.toggle('opt-disabled', c === 0 && !filters[col].has(v));
      });
    });
    try { const o = {}; filterKeys.forEach(k => { if (filters[k].size) o[k] = Array.from(filters[k]); }); localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); } catch (e) {}
  }
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { const o = JSON.parse(raw); filterKeys.forEach(k => { if (Array.isArray(o[k])) o[k].forEach(v => filters[k].add(v)); }); } } catch (e) {}
  document.querySelectorAll('.filter-bar .col-filter').forEach(trigger => {
    const col = trigger.dataset.col, dd = trigger.querySelector('.col-dropdown');
    const valid = new Set(); dd.querySelectorAll('input[type=checkbox]').forEach(cb => valid.add(cb.dataset.value));
    for (const v of Array.from(filters[col])) if (!valid.has(v)) filters[col].delete(v);
    trigger.classList.toggle('filtered', filters[col].size > 0);
    dd.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = filters[col].has(cb.dataset.value); });
    trigger.addEventListener('click', e => { if (e.target.closest('.col-dropdown')) return; e.stopPropagation(); document.querySelectorAll('.col-dropdown.open').forEach(d => { if (d !== dd) d.classList.remove('open'); }); dd.classList.toggle('open'); });
    dd.addEventListener('click', e => e.stopPropagation());
    const clr = dd.querySelector('.col-dropdown-clear');
    if (clr) clr.addEventListener('click', e => { e.stopPropagation(); filters[col].clear(); dd.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false); trigger.classList.remove('filtered'); apply(); });
    dd.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', e => { e.stopPropagation(); if (cb.checked) filters[col].add(cb.dataset.value); else filters[col].delete(cb.dataset.value); trigger.classList.toggle('filtered', filters[col].size > 0); apply(); }));
  });
  document.addEventListener('click', () => document.querySelectorAll('.col-dropdown.open').forEach(d => d.classList.remove('open')));
  if (searchEl) searchEl.addEventListener('input', () => { term = searchEl.value.trim().toLowerCase(); apply(); });
  if (newToggle) newToggle.addEventListener('click', () => { newOnly = !newOnly; newToggle.classList.toggle('active', newOnly); apply(); });
  if (newToggle && new URLSearchParams(location.search).get('new') === '1') { newOnly = true; newToggle.classList.add('active'); }
  function num(el, a) { return parseFloat(el.dataset[a]) || 0; }
  function sortNow() {
    if (!sortSel || !panel) return;
    const v = sortSel.value, arr = Array.from(panel.querySelectorAll('.lead'));
    arr.sort((a, b) => {
      if (v === 'score-asc') return num(a, 'score') - num(b, 'score');
      if (v === 'company') return (a.dataset.company || '').localeCompare(b.dataset.company || '', undefined, { sensitivity: 'base' });
      if (v === 'pay-desc') return num(b, 'pay') - num(a, 'pay');
      if (v === 'posted-desc') return (b.dataset.added || '').localeCompare(a.dataset.added || '');
      return num(b, 'score') - num(a, 'score');
    });
    arr.forEach(el => panel.appendChild(el));
  }
  if (sortSel) sortSel.addEventListener('change', sortNow);
  apply();
})();
</script>
`;
  return shell('Inbox', body, { view: 'inbox', ...getCounts() });
}

// ----- server -----

function parseQuery(urlStr) {
  const q = {};
  const idx = urlStr.indexOf('?');
  if (idx === -1) return q;
  const qs = urlStr.slice(idx + 1);
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return q;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// ----- Find New Jobs (auto-runs on startup via claude CLI) -----

// Persisted across restarts so the 24h cooldown survives quitting/relaunching.
const BATCH_STATE_FILE = join(ROOT, 'data', '.batch-state.json');
const BATCH_COOLDOWN_MS = 24 * 60 * 60 * 1000; // one batch per 24h unless overridden

function readBatchState() {
  try { return JSON.parse(readFileSync(BATCH_STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeBatchState(patch) {
  const next = { ...readBatchState(), ...patch };
  try {
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(BATCH_STATE_FILE, JSON.stringify(next, null, 2));
  } catch (e) { console.log(`[find-jobs] could not persist state: ${e.message}`); }
  return next;
}
// ms left before another batch is allowed; 0 means it can run now.
function batchCooldownRemainingMs() {
  const { lastRun } = readBatchState();
  if (!lastRun) return 0;
  const elapsed = Date.now() - new Date(lastRun).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.max(0, BATCH_COOLDOWN_MS - elapsed);
}

function spawnFindJobs() {
  if (server._batchProc && !server._batchDone) return false;
  const claudeCheck = spawnSync('which', ['claude']);
  if (claudeCheck.status !== 0) {
    console.log('[find-jobs] claude CLI not found in PATH, skipping');
    return false;
  }
  server._batchDone = false;
  server._batchExit = null;
  server._batchStarted = new Date().toISOString();
  server._batchOutput = '';
  // Stamp the run immediately so the 24h cooldown applies even if it later fails.
  writeBatchState({ lastRun: server._batchStarted });

  const proc = spawn('claude', [
    '-p',
    '--dangerously-skip-permissions',
    'run /get-the-job find-jobs'
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  server._batchProc = proc;
  const lines = [];
  const onData = (chunk) => {
    lines.push(...chunk.toString().split('\n'));
    if (lines.length > 50) lines.splice(0, lines.length - 50);
    server._batchOutput = lines.join('\n');
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    server._batchDone = true;
    server._batchExit = code;
    server._batchFinished = new Date().toISOString();
    writeBatchState({ lastExit: code, lastFinished: server._batchFinished });
    console.log(`[find-jobs] finished (exit ${code})`);
  });
  proc.on('error', (err) => {
    server._batchDone = true;
    server._batchExit = 1;
    server._batchFinished = new Date().toISOString();
    console.log(`[find-jobs] error: ${err.message}`);
  });
  console.log(`[find-jobs] started`);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    const query = parseQuery(url);

    // Dev ephemeral mode: reset the sandbox only when the ONBOARDING page is
    // (re)loaded, so refreshing the wizard gives a clean run — but completing it
    // and going to the dashboard ('/') still works. No-op unless EPHEMERAL=1 +
    // sandbox ROOT. (Wiping on '/' too would delete the just-created profile and
    // bounce you back to the start of onboarding.)
    if (EPHEMERAL && pathname === '/onboarding') {
      wipeEphemeralData();
    }

    // First-run: redirect to onboarding if profile.yml doesn't exist
    const profileExists = existsSync(join(ROOT, 'config', 'profile.yml'));
    if (!profileExists && (pathname === '/' || pathname === '/index.html' || pathname === '/triage')) {
      res.writeHead(302, { Location: '/onboarding' });
      res.end();
      return;
    }

    if (pathname === '/settings') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSettings());
      return;
    }

    if (pathname === '/onboarding') {
      const isPreview = query.preview === '1';
      const isEdit = query.edit === '1'; // re-run the wizard for real (saves), bypassing the "already set up" redirect
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (profileExists && !isPreview && !isEdit) {
        res.end(shell('Setup', '<h1>Already Set Up</h1><p>Your profile is configured. <a href="/?view=inbox">Go to your dashboard</a> or <a href="/settings">open Settings</a>.</p>'));
      } else {
        res.end(renderOnboarding(isPreview));
      }
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(query.view === 'pipeline' ? renderPipeline(query) : renderInbox(query));
      return;
    }
    if (pathname === '/report') {
      const r = renderReport(query);
      res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(r.body);
      return;
    }
    if (pathname === '/triage') {
      res.writeHead(302, { Location: '/?view=inbox' });
      res.end();
      return;
    }
    if (pathname === '/apply') {
      const r = renderApplyPack(query);
      res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(r.body);
      return;
    }
    if (pathname === '/output') {
      serveOutputPdf(query, res);
      return;
    }
    // ----- Onboarding API -----
    if (pathname === '/api/onboarding/complete' && req.method === 'POST') {
      try {
        const ct = (req.headers['content-type'] || '');
        let payload, pdfBuf;

        if (ct.includes('multipart/form-data')) {
          const { fields, files } = await readMultipart(req, ct);
          payload = JSON.parse(fields.payload || '{}');
          if (files.pdf) pdfBuf = files.pdf;
        } else {
          payload = await readOnboardingBody(req);
        }

        // Merge, don't replace. The wizard prefills from these same files, so a
        // normal re-run resubmits everything; `prior` is the safety net for the
        // cases where it can't (JS blocked, an old cached page, a scripted POST) —
        // there, anything the submission leaves empty keeps its current value.
        // When the form DID show the existing setup (payload.prefilled), an empty
        // field is an intentional deletion and is honoured.
        const prior = readExistingSetup() || {};
        const authoritative = payload.prefilled === true;
        const pick = (v, key) => {
          const s = String(v == null ? '' : v).trim();
          if (s) return s;
          return authoritative ? '' : String(prior[key] == null ? '' : prior[key]);
        };
        const pickList = (v, key) => {
          const a = Array.isArray(v) ? v.filter(x => x !== null && x !== undefined && x !== '') : [];
          if (a.length || authoritative) return a;
          return Array.isArray(prior[key]) ? prior[key] : [];
        };

        const name = pick(payload.name, 'name');
        const email = pick(payload.email, 'email');
        const location = pick(payload.location, 'location');
        const linkedin = pick(payload.linkedin, 'linkedin');
        let comp = pick(payload.comp, 'comp');
        const currency = pick(payload.currency, 'currency') || 'USD';
        const workpref = pick(payload.workpref, 'workpref') || 'hybrid';
        const avoid = pick(payload.avoid, 'avoid');
        const industries = pickList(payload.industries, 'industries');
        const roles = pickList(payload.roles, 'roles');
        const companies = pickList(payload.companies, 'companies');
        // Career stage, job types and the two flexible answers. An untouched
        // question falls back to what is already on disk (pick/pickList do this),
        // so a re-run that only changes an email cannot silently reset them.
        const rawStage = pick(payload.careerStage, 'careerStage');
        const careerStage = ['student', 'experienced'].includes(rawStage) ? rawStage : '';
        const isStudent = careerStage === 'student';
        const jobTypes = (isStudent ? pickList(payload.jobTypes, 'jobTypes') : [])
          .filter(t => JOB_TYPE_IDS.includes(t));
        const titlesOpen = payload.titleModeSet === true
          ? payload.titlesOpen === true
          : (authoritative ? false : prior.titlesOpen === true);
        const payOpen = payload.payModeSet === true
          ? payload.payOpen === true
          : (authoritative ? false : prior.payOpen === true);
        // Open on pay and a target range are contradictory instructions. The form
        // clears the box when you pick open; this makes it true of a stale prefill
        // or a hand-made request too, so no floor survives the choice.
        if (payOpen) comp = '';
        // The resume is never dropped by an empty textarea: an upload replaces it,
        // otherwise blank means "keep what cv.md already has".
        const cv = String(payload.cv == null ? '' : payload.cv).trim() ? payload.cv : (pdfBuf ? '' : prior.cv || '');

        // Defence in depth — the wizard validates these too, but a bad contact
        // address silently baked into every generated application is expensive.
        if (!String(name || '').trim()) {
          return sendJson(res, 200, { ok: false, error: 'A name is required — it goes on every generated resume.' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim())) {
          return sendJson(res, 200, { ok: false, error: 'That email address does not look valid (expected something like you@example.com).' });
        }

        // Safety net: before overwriting anything, snapshot the existing user
        // files so a re-run of the wizard can never silently destroy a profile.
        const backupPath = backupUserFiles();

        mkdirSync(join(ROOT, 'config'), { recursive: true });
        mkdirSync(join(ROOT, 'data'), { recursive: true });

        // A YAML double-quoted scalar accepts exactly the JSON escapes, so
        // JSON.stringify is the safe encoder here: it handles quotes, backslashes
        // AND newlines/tabs, which a hand-rolled regex missed — a multi-line
        // textarea used to emit raw line breaks and corrupt the whole file.
        const esc = (s) => JSON.stringify(s == null ? '' : String(s));
        // Multi-line values (the story textareas) are emitted as block scalars so
        // the file stays readable and round-trips byte-for-byte.
        const escBlock = (s, indent) => {
          const v = String(s == null ? '' : s).replace(/\r\n?/g, '\n');
          if (!/\n/.test(v)) return esc(v);
          const pad = ' '.repeat(indent);
          return '|-\n' + v.split('\n').map(l => (l.length ? pad + l : '')).join('\n');
        };

        const headline = pick(payload.headline, 'headline');
        const exitStory = pick(payload.exitStory, 'exitStory');
        const strengths = pickList(payload.strengths, 'strengths');
        const proofName = pick(payload.proofName, 'proofName');
        const proofMetric = pick(payload.proofMetric, 'proofMetric');
        const proofDetail = pick(payload.proofDetail, 'proofDetail');

        // Keys nobody in this wizard owns (a hand-added `language:`, extra
        // `candidate.github`, a second proof point) are copied through verbatim.
        const priorProfile = loadYamlFile('config/profile.yml') || {};
        // The work-style select sits in a collapsed section and has a default selected
        // option, so its value alone cannot tell us whether the user answered. Recording
        // an unanswered "hybrid" would invent a preference that then feeds scoring. Count
        // it as answered only if the user touched it, or a previous run already stored one.
        const workprefSet = payload.workprefSet === true
          || !!(priorProfile.preferences && priorProfile.preferences.work_style);
        const extraProofPoints = (Array.isArray(priorProfile.narrative && priorProfile.narrative.proof_points)
          ? priorProfile.narrative.proof_points.slice(1) : []).filter(p => p && typeof p === 'object');

        let profileYml = '# ' + PRODUCT_NAME + ' profile — written by the setup wizard.\n';
        profileYml += '# Plain YAML: edit it by hand, or ask Claude Code to change it for you.\n';
        profileYml += '# Re-running the wizard reads this file first and keeps whatever you do not change.\n\n';
        profileYml += 'candidate:\n';
        profileYml += '  full_name: ' + esc(name) + '\n';
        profileYml += '  email: ' + esc(email) + '\n';
        profileYml += '  location: ' + esc(location) + '\n';
        if (linkedin) profileYml += '  linkedin: ' + esc(linkedin) + '\n';
        profileYml += dumpExtraKeys(priorProfile.candidate, ['full_name', 'email', 'location', 'linkedin'], 2);
        profileYml += '\ntarget_roles:\n';
        // Explicit empty list, never a bare `primary:` — that parses as null and
        // every reader then has to special-case it.
        if (roles.length) {
          profileYml += '  primary:\n';
          roles.forEach(r => { profileYml += '    - ' + esc(r) + '\n'; });
        } else {
          profileYml += '  primary: []   # no target titles set — scans keep every role your companies post\n';
        }
        if (titlesOpen) {
          profileYml += '  flexible: true   # open to any title in your field — scans do not filter on title\n';
        }
        profileYml += dumpExtraKeys(priorProfile.target_roles, ['primary', 'flexible'], 2);
        if (careerStage) {
          profileYml += '\ncareer_stage: ' + esc(careerStage) + '   # student | experienced\n';
          if (jobTypes.length) {
            profileYml += 'job_types:\n';
            jobTypes.forEach(t => { profileYml += '  - ' + esc(t) + '\n'; });
          }
        }
        // The fields you picked drive company suggestions and the fallback title
        // keywords, so they have to persist or a re-run silently narrows your scan.
        if (industries.length) {
          profileYml += '\n# Fields you picked in setup — used to suggest companies and job-title keywords.\n';
          profileYml += 'industries:\n';
          industries.forEach(i => { profileYml += '  - ' + esc(i) + '\n'; });
        }
        const extraPrefs = dumpExtraKeys(priorProfile.preferences, ['work_style'], 2);
        if (workprefSet || extraPrefs) {
          profileYml += '\npreferences:\n';
          if (workprefSet) profileYml += '  work_style: ' + esc(workpref) + '   # remote | hybrid | onsite\n';
          profileYml += extraPrefs;
        }
        if (payOpen) {
          profileYml += '\ncompensation:\n';
          profileYml += '  open: true   # no pay floor — comp is left out of scoring entirely\n';
          profileYml += dumpExtraKeys(priorProfile.compensation, ['target_range', 'currency', 'open'], 2);
        } else if (comp) {
          profileYml += '\ncompensation:\n';
          profileYml += '  target_range: ' + esc(comp) + '\n';
          profileYml += '  currency: ' + esc(currency || 'USD') + '\n';
          profileYml += dumpExtraKeys(priorProfile.compensation, ['target_range', 'currency', 'open'], 2);
        }
        if (headline || exitStory || strengths.length || proofName || extraProofPoints.length) {
          profileYml += '\nnarrative:\n';
          if (headline) profileYml += '  headline: ' + esc(headline) + '\n';
          if (exitStory) profileYml += '  exit_story: ' + escBlock(exitStory, 4) + '\n';
          if (strengths.length) {
            profileYml += '  superpowers:\n';
            strengths.forEach(s => { profileYml += '    - ' + esc(s) + '\n'; });
          }
          if (proofName || extraProofPoints.length) {
            profileYml += '  proof_points:\n';
            if (proofName) {
              profileYml += '    - name: ' + esc(proofName) + '\n';
              if (proofMetric) profileYml += '      hero_metric: ' + esc(proofMetric) + '\n';
              if (proofDetail) profileYml += '      description: ' + escBlock(proofDetail, 8) + '\n';
            }
            extraProofPoints.forEach(p => {
              profileYml += yaml.dump([p], { lineWidth: 120 }).split('\n').filter(l => l.length)
                .map(l => '    ' + l).join('\n') + '\n';
            });
          }
          profileYml += dumpExtraKeys(priorProfile.narrative, ['headline', 'exit_story', 'superpowers', 'proof_points'], 2);
        }
        // career_stage and job_types belong on this list: the wizard writes them
        // above, and leaving them out emitted them a second time here — a duplicate
        // top-level key, which the YAML validator below rejects outright.
        const priorProfileExtras = dumpExtraKeys(priorProfile,
          ['candidate', 'target_roles', 'industries', 'preferences', 'compensation', 'narrative',
           'career_stage', 'job_types'], 0);
        if (priorProfileExtras) {
          profileYml += '\n# Kept from your previous profile.yml (the setup wizard does not manage these).\n';
          profileYml += priorProfileExtras;
        }

        // The wizard has no field for negatives/boosts/hand-added titles, so a re-run
        // must reuse whatever is already there instead of resetting hand-tuned lists.
        const priorPortals = loadYamlFile('portals.yml') || {};
        const priorFilter = (priorPortals.title_filter && typeof priorPortals.title_filter === 'object') ? priorPortals.title_filter : {};

        // See expandRoleKeywords(): each role becomes the whole phrase plus the
        // qualifier+head combinations that keep its domain word, and never a bare
        // "Analyst"/"Engineer"/"Manager". scan.mjs matches a keyword's words as a
        // phrase, which is what lets these stay narrow without missing inverted
        // titles like "Analyst, Clinical Data".
        // A student's titles are prepended, never appended: the industry seed is
        // capped at 24 keywords, and without this the cap was reached by mid-level
        // titles alone and every internship keyword fell off the end.
        const seedFromIndustries = (ids, stage, types) => {
          const suggested = stage === 'student' ? studentTitleSeeds(types).slice() : [];
          (Array.isArray(ids) ? ids : []).forEach(id => (ROLE_SUGGESTIONS[id] || []).forEach(t => suggested.push(t)));
          return expandRoleKeywords(suggested).slice(0, 24);
        };
        // "Open to anything in my field" writes no positive filter at all. This is
        // NOT the same as leaving the titles empty, which still seeds from the
        // field's example titles — on a live 3-company scan that dropped 596 of 627
        // postings, which is exactly the inflexibility the choice exists to escape.
        let positive = titlesOpen ? [] : expandRoleKeywords(roles);
        let positiveNote = titlesOpen
          ? '#   You chose "open to anything in my field", so there is no title filter:\n' +
            '#   every posting is kept and scored. Add lines here to start narrowing.\n'
          : '#   Generated from your target roles, plus the variants real boards use.\n';
        if (!titlesOpen && !positive.length && isStudent) {
          // A student with no titles still needs the early-career words, with or
          // without a field: "Intern" is not in any ROLE_SUGGESTIONS list.
          positive = expandRoleKeywords(studentTitleSeeds(jobTypes));
          positiveNote = '#   You did not set target roles, so these are the early-career titles for\n' +
                         '#   the job types you picked. Add your own for a tighter Inbox.\n';
        }
        if (!titlesOpen && !positive.length && Array.isArray(industries) && industries.length) {
          // No titles given but a field was chosen: use that field's example job
          // titles, expanded the same way. Taking only their last words used to emit
          // bare "Analyst"/"Manager", which kept most of every board.
          positive = seedFromIndustries(industries);
          if (positive.length) {
            positiveNote = '#   You did not set target roles, so these come from the example job titles\n' +
                           '#   in the field(s) you picked. Replace them with your own for a tighter Inbox.\n';
          }
        }
        // A re-run regenerates this list, and it used to shrink a widened list back to
        // the four keywords the roles produce — throwing away every title the user (or
        // a later scan) had added, while the finish screen promised "anything you leave
        // alone is kept". So: what the PREVIOUS run would have generated is ours to
        // replace; everything else in the list was put there by hand and survives.
        const priorRoles = yArr(priorProfile.target_roles && priorProfile.target_roles.primary);
        const managed = new Set(
          [...expandRoleKeywords(priorRoles), ...(priorRoles.length ? [] : seedFromIndustries(yArr(priorProfile.industries)))]
            .map(k => k.toLowerCase()));
        const generated = new Set(positive.map(k => k.toLowerCase()));
        const handAdded = yArr(priorFilter.positive)
          .filter(k => !managed.has(k.toLowerCase()) && !generated.has(k.toLowerCase()));
        let keptNote = '';
        if (handAdded.length) {
          positive = positive.concat(handAdded);
          keptNote = '#   The last ' + handAdded.length + ' were already in your portals.yml and were kept.\n';
        }
        let portalsYml = '# ' + PRODUCT_NAME + ' scan config — written by the setup wizard.\n';
        portalsYml += '# tracked_companies: whose job boards get checked.\n';
        if (titlesOpen) {
          portalsYml += positiveNote;
        } else {
          portalsYml += '# title_filter.positive: a title is kept when ONE of these reads as a phrase\n';
          portalsYml += '#   in it — so "backend engineer" matches "Backend Engineer", "Backend Platform\n';
          portalsYml += '#   Engineer" and "Software Engineer, Backend", but not "Support Engineer" and\n';
          portalsYml += '#   not "Data Center Electrical Engineer".\n';
          portalsYml += positiveNote;
          portalsYml += keptNote;
          portalsYml += '#   Add your own lines to widen the net; an empty list keeps every title.\n';
        }
        portalsYml += '\ntitle_filter:\n';
        if (positive.length) {
          portalsYml += '  positive:\n';
          positive.forEach(kw => { portalsYml += '    - ' + esc(kw) + '\n'; });
        } else if (titlesOpen) {
          portalsYml += '  positive: []   # open to any title in your field — nothing is filtered out\n';
        } else {
          portalsYml += '  positive: []   # no target roles set — every title is kept\n';
        }
        // Seniority lists follow the career stage. These used to be hardcoded to the
        // experienced set for everybody, which put "Intern" and "Internship" in the
        // EXCLUDE list — a student's whole search, dropped before it was ever scored.
        //
        // A list that matches what a previous run would have generated is ours to
        // replace (so switching stage actually takes effect); anything else was
        // hand-tuned and survives untouched, same contract as the positive list.
        const stageRules = STAGE_TITLE_RULES[isStudent ? 'student' : 'experienced'];
        const isGenerated = (list) => {
          const norm = a => a.map(s => String(s).toLowerCase()).sort().join('|');
          const k = norm(list);
          return Object.keys(STAGE_TITLE_RULES).some(s =>
            k === norm(STAGE_TITLE_RULES[s].negative) || k === norm(STAGE_TITLE_RULES[s].boost));
        };
        const priorNeg = yArr(priorFilter.negative);
        const priorBoost = yArr(priorFilter.seniority_boost);
        const negatives = (priorNeg.length && !isGenerated(priorNeg)) ? priorNeg : stageRules.negative;
        const boosts = (priorBoost.length && !isGenerated(priorBoost)) ? priorBoost : stageRules.boost;
        portalsYml += '  # negative drops any title containing one of these. Plain substrings, so keep\n';
        portalsYml += '  # them specific: a bare "Lead" would also drop "Lead Generation Intern".\n';
        portalsYml += '  negative:\n';
        negatives.forEach(kw => { portalsYml += '    - ' + esc(kw) + '\n'; });
        portalsYml += '  # seniority_boost is a priority hint for the AI scorer, not a filter.\n';
        portalsYml += '  seniority_boost:\n';
        boosts.forEach(kw => { portalsYml += '    - ' + esc(kw) + '\n'; });
        portalsYml += dumpExtraKeys(priorFilter, ['positive', 'negative', 'seniority_boost'], 2);
        // Companies the user picked/added in the wizard. Each was already
        // validated to a Greenhouse/Ashby/Lever board, so scan.mjs can use them.
        const validCompanies = (Array.isArray(companies) ? companies : [])
          .filter(c => c && c.name && c.careers_url);
        if (validCompanies.length) {
          portalsYml += '\ntracked_companies:\n';
          validCompanies.forEach(c => {
            portalsYml += '  - name: ' + esc(c.name) + '\n';
            portalsYml += '    careers_url: ' + esc(c.careers_url) + '\n';
            if (c.api) portalsYml += '    api: ' + esc(c.api) + '\n';
            portalsYml += '    enabled: true\n';
          });
        } else {
          portalsYml += '\ntracked_companies: []\n';
        }
        // Where the user lives, recorded for the AI scoring step — the location policy
        // written into modes/_profile.md is what actually uses it. The scanner does NOT
        // filter or sort on location: these boards are worldwide, and filtering on a city
        // would leave a non-US user with an empty Inbox. Don't let the copy claim otherwise.
        if (location || workprefSet) {
          portalsYml += '\n# Read by the AI scoring step (via modes/_profile.md), not by the scanner.\n';
          portalsYml += '# The scan does not filter or sort on location — these boards are worldwide.\n';
          portalsYml += 'location_preference:\n';
          if (location) portalsYml += '  near: ' + esc(location) + '\n';
          if (workprefSet) portalsYml += '  work_style: ' + esc(workpref) + '\n';
        }
        const priorQueries = Array.isArray(priorPortals.search_queries) ? priorPortals.search_queries : [];
        if (priorQueries.length) {
          portalsYml += '\nsearch_queries:\n';
          portalsYml += yaml.dump(priorQueries, { lineWidth: 120 }).split('\n').filter(l => l.length).map(l => '  ' + l).join('\n') + '\n';
        } else {
          portalsYml += '\nsearch_queries: []\n';
        }
        const priorPortalExtras = dumpExtraKeys(priorPortals, ['title_filter', 'tracked_companies', 'search_queries', 'location_preference'], 0);
        if (priorPortalExtras) {
          portalsYml += '\n# Kept from your previous portals.yml (the setup wizard does not manage these).\n';
          portalsYml += priorPortalExtras;
        }

        // Nothing is written until both files parse. A green "✓ Profile" over an
        // unparseable config is worse than a visible failure.
        for (const [label, text] of [['config/profile.yml', profileYml], ['portals.yml', portalsYml]]) {
          try { yaml.load(text); }
          catch (e) {
            return sendJson(res, 200, { ok: false, error: 'Could not write a valid ' + label + ' from those answers (' + e.message + '). Nothing was changed.' });
          }
        }
        writeFileSync(join(ROOT, 'config', 'profile.yml'), profileYml);
        writeFileSync(join(ROOT, 'portals.yml'), portalsYml);

        if (pdfBuf) {
          writeFileSync(join(ROOT, 'cv.pdf'), pdfBuf);
        }
        // cv.md always exists after setup. Everything downstream (scoring, CV and
        // cover-letter generation, doctor.mjs, Claude Code's own first-run check)
        // reads this exact file, so "no resume yet" must be an empty scaffold
        // rather than a missing file.
        if (cv && cv.trim()) {
          writeFileSync(join(ROOT, 'cv.md'), cv);
        } else if (pdfBuf) {
          // PDF uploaded without pasted text. The AI reads cv.md, so leave a stub
          // that tells Claude Code to convert the PDF on first use — keeps the
          // data contract intact and makes the next step explicit.
          writeFileSync(join(ROOT, 'cv.md'),
            '<!-- Your resume was uploaded as cv.pdf but not yet converted to Markdown.\n' +
            '     Before scoring jobs, open this project in Claude Code and ask it:\n' +
            '     "convert cv.pdf into cv.md". The AI reads cv.md (not the PDF). -->\n');
        } else if (!existsSync(join(ROOT, 'cv.md'))) {
          const nm = String(name || 'Your Name').trim();
          writeFileSync(join(ROOT, 'cv.md'),
            '# ' + nm + '\n\n' +
            (location ? '**Location:** ' + location + '\n' : '') +
            '**Email:** ' + String(email || '').trim() + '\n' +
            (linkedin ? '**LinkedIn:** ' + linkedin + '\n' : '') +
            '\n<!-- Your resume is not filled in yet, and nothing can be SCORED until it is.\n' +
            '     Two ways to finish it:\n' +
            '       1. Paste your resume under the headings below. Plain text is fine.\n' +
            '       2. Or drop your resume PDF into this folder and ask Claude Code:\n' +
            '          "convert my resume PDF into cv.md".\n' +
            '     This file (cv.md) is the one the scorer and every generated resume and\n' +
            '     cover letter reads. -->\n\n' +
            '## Professional Summary\n\n\n## Work Experience\n\n\n## Education\n\n\n## Skills\n\n');
        }

        // Generate modes/_profile.md — the user's scoring guardrails + target
        // roles that triage/_shared read at runtime. Without this, scoring would
        // fall back to template defaults. Non-fatal if it fails.
        try {
          mkdirSync(join(ROOT, 'modes'), { recursive: true });
          const roleList = (roles || []).filter(Boolean);
          const cur = currency || 'USD';
          // Comp floor = low end of the entered range.
          const compFloor = (() => {
            const toks = String(comp || '').match(/\d[\d,.]*\s*[kKmM]?/g);
            if (!toks || !toks.length) return '';
            const val = s => { let n = parseFloat(s.replace(/[, ]/g, '')); if (/[kK]/.test(s)) n *= 1e3; if (/[mM]/.test(s)) n *= 1e6; return n; };
            return toks.slice().sort((a, b) => val(a) - val(b))[0].trim();
          })();
          const floorDisplay = compFloor ? (cur + ' ' + compFloor).trim() : '';
          const wp = workpref || 'hybrid';
          const locPolicy = wp === 'remote'
            ? 'Remote only. Fully remote = 5.0. On-site or office-required hybrid scored ≤2.0 unless exceptional.'
            : wp === 'onsite'
              ? 'Open to on-site and relocation' + (location ? ' (based in ' + location + ')' : '') + '. Location is not a strong filter; score on fit.'
              : 'Remote preferred. Hybrid near ' + (location || 'your area') + ' is fine. On-site far from there is scored down, not excluded.';
          const avoidItems = String(avoid || '').split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
          // Hard = the user's explicit "rule out" choices. Soft = comp below floor
          // (penalize, don't drop a near-miss). Editable later in Settings/Inbox.
          const hardItems = [];
          if (wp === 'remote') hardItems.push(SYNTH_ONSITE_HARD);
          avoidItems.forEach(a => hardItems.push(a));
          const softItems = [];
          if (floorDisplay) softItems.push('Comp below your floor (' + floorDisplay + ') — push the score down and flag the gap.');

          // Rules the wizard's comma-separated box cannot represent (long ones,
          // ones containing a comma — i.e. most of what Settings → Scoring rules
          // writes) were never shown here, so re-running must carry them over
          // rather than silently deleting them. Same for every soft penalty, since
          // the wizard has no soft field at all.
          const priorGuard = readGuardrails();
          (priorGuard.hard || []).forEach(h => {
            if (h === SYNTH_ONSITE_HARD) return;                 // recomputed from work style
            if (isAvoidBoxItem(h)) return;                       // the avoid box owns these
            if (hardItems.indexOf(h) < 0) hardItems.push(h);
          });
          (priorGuard.soft || []).forEach(s => {
            if (s.indexOf(SYNTH_COMP_SOFT_PREFIX) === 0) return; // recomputed from the comp floor
            if (softItems.indexOf(s) < 0) softItems.push(s);
          });

          let pm = '# User Profile Context — get-the-job' + (name ? ' (' + name + ')' : '') + '\n\n';
          pm += '<!-- Generated by the onboarding wizard. This file is yours — edit it freely.\n';
          pm += '     The system reads _shared.md first, then this file (your overrides win). -->\n\n';
          pm += '## Your Target Roles\n\n';
          if (titlesOpen) {
            const fieldNames = industries
              .map(i => (INDUSTRIES.filter(x => x.id === i)[0] || {}).label || i).join(' / ');
            pm += 'Deliberately open: any role in ' + (fieldNames || 'your field') + ' is on the table.\n';
            pm += 'Score on the work described and how well the resume matches it, never on whether the\n';
            pm += 'title appears in a list.\n';
            if (roleList.length) {
              pm += '\nTitles noted as examples of what fits — not a filter:\n\n';
              roleList.forEach(r => { pm += '- ' + r + '\n'; });
            }
          } else {
            pm += 'The roles you are optimizing for. The scorer rewards strong matches and penalizes roles far outside this set.\n\n';
            if (roleList.length) roleList.forEach(r => { pm += '- ' + r + '\n'; });
            else pm += '- _Add your target roles here._\n';
          }
          pm += '\n## Your Comp Targets\n\n';
          if (payOpen) {
            pm += '- **Open on pay.** Do not score compensation at all, and do not push a score down\n';
            pm += '  because a posting omits salary — there is no floor to compare it against. Still\n';
            pm += '  surface the range when the JD states one, as information rather than as a penalty.\n';
          } else {
            pm += comp ? ('- **Target range:** ' + comp + ' ' + cur + '\n') : '- **Target range:** _not set_\n';
            if (floorDisplay) pm += '- **Floor (walk-away):** ' + floorDisplay + ' — score roles known to pay below this ≤2.5 and flag the gap.\n';
            pm += '- Validate specific companies with WebSearch (Levels.fyi, Glassdoor, Blind) when comp is not in the JD.\n';
          }
          pm += '\n## Your Location Policy\n\n';
          if (location) pm += '- **Based in:** ' + location + '\n';
          pm += '- ' + locPolicy + '\n';
          pm += '\n## Your Guardrails / Deal-Breakers\n\n';
          pm += 'How the scorer uses this: **Hard** exclusions drop a posting (score 1.0). **Soft** penalties just lower its score. Edit these anytime in Settings.\n\n';
          pm += managedBlock(hardItems, softItems) + '\n';
          if (isStudent) {
            pm += '\n**Career stage: student / early career.** Score internships, co-ops, working-student\n';
            pm += 'and graduate postings on their own merits — being junior is never itself a negative,\n';
            pm += 'and a thin resume is expected at this stage. What to penalize instead: postings that\n';
            pm += 'demand years of experience the resume cannot show, and senior/staff/lead titles.\n';
            if (jobTypes.length) {
              pm += 'Wanted: ' + jobTypes.map(t => JOB_TYPE_LABELS[t] || t).join(', ') +
                '. Score a different arrangement down, not out — say so in the verdict.\n';
            }
          } else {
            pm += '\n**Seniority/experience:** the scorer compares each JD against your resume (`cv.md`) and penalizes large gaps — it does not use a fixed year threshold.\n';
          }
          if (titlesOpen) {
            pm += '\n**Open on job titles.** Any title in your field is fair game — never score a posting\n';
            pm += 'down just because its title is outside a target list. Judge it on the work described,\n';
            pm += 'the field, and how well your resume matches what it actually asks for.\n';
          }
          pm += '\n_Everything else (cover-letter voice, negotiation, framing) uses the generic defaults in `_shared.md` until you customize it here._\n';

          // Sections the user (or Claude Code) added to _profile.md are their own
          // customizations — the four headings above are the only ones this wizard
          // owns, so everything else is carried over verbatim.
          try {
            const pmPath = join(ROOT, 'modes', '_profile.md');
            if (existsSync(pmPath)) {
              const owned = ['your target roles', 'your comp targets', 'your location policy'];
              const prevLines = readFileSync(pmPath, 'utf8').split('\n');
              const keep = [];
              let taking = false;
              for (const l of prevLines) {
                if (/^##\s+/.test(l)) {
                  const h = l.replace(/^##\s+/, '').trim().toLowerCase();
                  taking = !(owned.includes(h) || GUARD_HEADING_RE.test(l));
                  if (taking) keep.push('', l);
                  continue;
                }
                if (taking) keep.push(l);
              }
              const extra = keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
              if (extra) pm += '\n' + extra + '\n';
            }
          } catch (e) { /* carrying extra sections over is best-effort */ }
          writeFileSync(join(ROOT, 'modes', '_profile.md'), pm);
        } catch (e) { /* non-fatal: _profile.md generation must not block setup */ }

        if (!existsSync(join(ROOT, 'data', 'applications.md'))) {
          writeFileSync(join(ROOT, 'data', 'applications.md'),
            '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
        }
        // scan.mjs APPENDS into data/pipeline.md and reads it without an existence
        // guard, so on a fresh clone the very first scan that finds a job used to
        // die with ENOENT. New files get ENGLISH section headings ("## Pending" /
        // "## Processed"); scan.mjs and loadScanQueue() below still read the older
        // Spanish spellings, so an existing user's file keeps working untouched.
        if (!existsSync(join(ROOT, 'data', 'pipeline.md'))) {
          writeFileSync(join(ROOT, 'data', 'pipeline.md'),
            '# Pipeline — job URLs waiting to be scored\n\n' +
            'The scanner appends new postings under "Pending". Score them in Claude Code\n' +
            'with `/get-the-job triage`; scored ones move to "Processed".\n\n' +
            '## Pending\n\n## Processed\n');
        }
        // Same reasoning for the dedup history: seed the header so the first scan
        // and the dashboard both read a well-formed file.
        if (!existsSync(join(ROOT, 'data', 'scan-history.tsv'))) {
          writeFileSync(join(ROOT, 'data', 'scan-history.tsv'),
            'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
        }

        return sendJson(res, 200, { ok: true, backup: backupPath });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (pathname === '/api/onboarding/verify-company' && req.method === 'POST') {
      try {
        const body = await readOnboardingBody(req);
        const detected = detectAtsFromUrl(body.url);
        // Plain-language errors: "not a recognized Greenhouse/Ashby/Lever board"
        // names three products most people have never heard of, and most large
        // employers are on Workday — so say what we can read and what to do next.
        if (!detected) {
          return sendJson(res, 200, {
            ok: false,
            error: "We can't scan that address automatically.",
            hint: 'The scanner reads three job-board platforms. Look at the URL of the company\'s job listings: it needs to contain greenhouse.io, ashbyhq.com or lever.co. Employers on Workday, Taleo or SmartRecruiters can\'t be scanned — you can still paste individual job links into your Inbox later.',
          });
        }
        const count = await countAtsJobs(detected);
        if (count == null) {
          return sendJson(res, 200, {
            ok: false,
            error: "That board didn't answer.",
            hint: 'Either the company name in the URL is spelled differently (check the address on their careers page) or the board no longer exists.',
          });
        }
        if (count === 0) {
          return sendJson(res, 200, {
            ok: false,
            error: 'That board is readable but has no open roles right now.',
            hint: 'Nothing to track yet — try again another day, or add a different company.',
          });
        }
        // Match the catalog's storage format: keep an explicit api only for
        // Greenhouse; scan.mjs derives Ashby/Lever APIs from careers_url.
        const out = { ok: true, name: detected.name, careers_url: detected.careers_url, count };
        if (detected.type === 'greenhouse') out.api = detected.api;
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (pathname === '/api/companies' && req.method === 'POST') {
      try {
        const body = await readOnboardingBody(req);
        const count = writeTrackedCompanies(body.companies);
        return sendJson(res, 200, { ok: true, count });
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }

    if (pathname === '/api/guardrails' && req.method === 'GET') {
      try { return sendJson(res, 200, readGuardrails()); }
      catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }
    if (pathname === '/api/guardrails' && req.method === 'POST') {
      try {
        const body = await readOnboardingBody(req);
        const hard = Array.isArray(body.hard) ? body.hard : [];
        const soft = Array.isArray(body.soft) ? body.soft : [];
        const counts = writeGuardrails(hard, soft);
        return sendJson(res, 200, { ok: true, ...counts });
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }

    // ----- Scan API -----
    if (pathname === '/api/run-scan' && req.method === 'POST') {
      if (server._scanProc && !server._scanDone) return sendJson(res, 409, { ok: false, error: 'scan already running' });
      try {
        server._scanDone = false;
        server._scanExit = null;
        // The script ships with the source tree; the data it reads and writes
        // (portals.yml, data/*) lives in ROOT, which scan.mjs resolves from cwd.
        // These are the same directory for a normal install and differ only in a
        // DATA_DIR sandbox — join(ROOT) there looked for a scan.mjs that isn't
        // in the sandbox and failed with exit 1.
        const proc = spawn('node', [join(SRC_DIR, 'scan.mjs')], { cwd: ROOT, stdio: 'ignore' });
        server._scanProc = proc;
        proc.on('close', (code) => { server._scanDone = true; server._scanExit = code; });
        proc.on('error', () => { server._scanDone = true; server._scanExit = 1; });
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }
    if (pathname === '/api/scan-status' && req.method === 'GET') {
      return sendJson(res, 200, { running: !server._scanDone, exitCode: server._scanExit });
    }

    // ----- Quit API -----
    if (pathname === '/api/quit' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      console.log('[server] quit requested from dashboard');
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // ----- Liveness ping (used by launcher + the file:// welcome page to detect a
    // running instance). CORS is opened on THIS endpoint only so the static
    // web/welcome.html (a file:// origin) can poll it and auto-forward to the
    // dashboard. Returns no sensitive data and the server binds localhost. -----
    if (pathname === '/api/ping' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, app: 'getthejob', pid: process.pid, uptime: Math.round(process.uptime()) }));
      return;
    }

    // ----- Find New Jobs API -----
    if (pathname === '/api/run-batch' && req.method === 'POST') {
      if (server._batchProc && !server._batchDone) return sendJson(res, 409, { ok: false, error: 'job search already running' });
      const override = query.override === '1';
      const remaining = batchCooldownRemainingMs();
      if (remaining > 0 && !override) {
        return sendJson(res, 429, {
          ok: false,
          cooldown: true,
          remainingMs: remaining,
          lastRun: readBatchState().lastRun || null,
          error: 'You already searched for new jobs in the last 24h. Override to run anyway.',
        });
      }
      const started = spawnFindJobs();
      if (!started) return sendJson(res, 500, { ok: false, error: 'claude CLI not found' });
      return sendJson(res, 200, { ok: true, overridden: override && remaining > 0 });
    }
    if (pathname === '/api/batch-status' && req.method === 'GET') {
      const remaining = batchCooldownRemainingMs();
      return sendJson(res, 200, {
        running: !!(server._batchProc && !server._batchDone),
        exitCode: server._batchExit ?? null,
        started: server._batchStarted || null,
        finished: server._batchFinished || null,
        lastRun: readBatchState().lastRun || null,
        cooldownRemainingMs: remaining,
        cooldownActive: remaining > 0,
      });
    }

    // ----- API endpoints -----
    if (pathname === '/api/report' && req.method === 'GET') {
      const file = query.file || '';
      if (!/^reports\/[\w.\-]+\.md$/.test(file)) return sendJson(res, 400, { ok: false, error: 'invalid path' });
      const abs = join(ROOT, file);
      if (!existsSync(abs)) return sendJson(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderMarkdown(readFileSync(abs, 'utf8')));
      return;
    }
    if (pathname === '/api/apply' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        spawnTerminalApply(body.url || '');
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }
    if (pathname === '/api/mark-applied' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, setRowStatus(body.num, 'Applied')); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (pathname === '/api/set-status' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, setRowStatus(body.num, body.status)); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (pathname === '/api/triage-dismiss' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, dismissTriageRow(body.url || '')); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (pathname === '/api/shortlist' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, shortlistFromTriage(body)); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (pathname === '/api/delete-row' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try { return sendJson(res, 200, deleteRowFromTracker(body.num)); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(shell('Not found', '<h1>404</h1><p>Not found.</p><p><a href="/?view=pipeline">← Back</a></p>'));
  } catch (err) {
    console.error('[server error]', err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`GetTheJob → http://localhost:${PORT}`);
  console.log(`  Data dir: ${ROOT}`);
  console.log(`  /         tracker (data/applications.md)`);
  console.log(`  /triage   triage scores (data/triage-scores.tsv)`);
  console.log(`  /report?file=reports/<file>.md   single report`);
  console.log(`  /apply?row=NNN                   apply pack (answers + CV + cover letter)`);
  console.log(`  /output?file=NAME.pdf            serve a generated PDF`);

  // Auto-launch Find New Jobs on startup (opt-in via AUTOSTART_BATCH=1).
  // Defaults OFF so restarting the server never kicks off a surprise run;
  // the launcher scripts set AUTOSTART_BATCH=1 to preserve double-click behavior.
  if (process.env.AUTOSTART_BATCH === '1') {
    const remaining = batchCooldownRemainingMs();
    if (remaining > 0) {
      const hrs = (remaining / 3600000).toFixed(1);
      console.log(`  [find-jobs] already ran within the last 24h — skipping auto-start (next in ${hrs}h). Override from the dashboard.`);
    } else {
      const claudeCheck = spawnSync('which', ['claude']);
      if (claudeCheck.status === 0) {
        console.log(`  [find-jobs] claude CLI found — auto-starting...`);
        spawnFindJobs();
      } else {
        console.log(`  [find-jobs] claude CLI not found — skipping auto-batch`);
      }
    }
  } else {
    console.log(`  [find-jobs] auto-start off (set AUTOSTART_BATCH=1 to enable); use the Find New Jobs button`);
  }
});
