#!/usr/bin/env node
// GetTheJob — job application dashboard
// Zero npm deps. Built-ins only: node:http, node:fs, node:path, node:url.
// Works standalone or pointed at a get-the-job data directory.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, renameSync, readdirSync, createReadStream, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const PORT = process.env.PORT || 3737;
const ROOT = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(fileURLToPath(import.meta.url), '..');

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
  health: ['Bioinformatics Engineer', 'Clinical Data Analyst', 'Health Informatics Specialist', 'Biostatistician', 'Regulatory Affairs Specialist', 'Medical Science Liaison', 'Clinical Research Associate', 'Healthcare Product Manager', 'Computational Biologist', 'Pharmacovigilance Analyst'],
  legal: ['Legal Analyst', 'Compliance Manager', 'Paralegal', 'Legal Operations Manager', 'Contract Manager', 'Privacy Officer', 'Legal Counsel', 'Policy Analyst', 'Regulatory Specialist', 'IP Analyst'],
  climate: ['Sustainability Analyst', 'Energy Engineer', 'Climate Data Scientist', 'Environmental Consultant', 'Carbon Markets Analyst', 'Clean Energy Product Manager', 'ESG Analyst', 'Grid Optimization Engineer', 'Renewable Energy Specialist'],
  education: ['Curriculum Designer', 'Instructional Designer', 'EdTech Product Manager', 'Learning Engineer', 'Data Analyst', 'Academic Advisor', 'Education Program Manager', 'Assessment Specialist', 'Online Course Developer'],
  media: ['Content Strategist', 'Product Manager', 'Data Analyst', 'UX Designer', 'Growth Manager', 'Marketing Manager', 'Creative Director', 'Video Producer', 'Audience Development Manager'],
  consulting: ['Management Consultant', 'Strategy Consultant', 'Business Analyst', 'Technology Consultant', 'Implementation Consultant', 'Project Manager', 'Solutions Consultant', 'Digital Transformation Lead', 'Change Management Consultant'],
  government: ['Policy Analyst', 'Data Analyst', 'Program Manager', 'IT Specialist', 'Grants Manager', 'Urban Planner', 'Public Affairs Specialist', 'Intelligence Analyst', 'Cybersecurity Analyst'],
  retail: ['E-commerce Manager', 'Supply Chain Analyst', 'Merchandising Analyst', 'Product Manager', 'Data Analyst', 'Category Manager', 'Logistics Coordinator', 'Demand Planner', 'Digital Marketing Manager'],
  manufacturing: ['Supply Chain Manager', 'Process Engineer', 'Quality Engineer', 'Operations Manager', 'Manufacturing Engineer', 'Industrial Engineer', 'Automation Engineer', 'Production Planner', 'Logistics Manager'],
  other: ['Project Manager', 'Product Manager', 'Data Analyst', 'Business Analyst', 'Operations Manager', 'Marketing Manager', 'UX Designer', 'Software Engineer'],
};

// ----- helpers -----

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
.container { max-width: 1180px; margin: 0 auto; padding: 26px 28px 64px; }
.container.wide { max-width: 1320px; }
a { color: var(--accent); }
h1 { font-size: 23px; margin: 0 0 16px; letter-spacing: -.02em; font-weight: 730; }
h2 { font-size: 17px; margin: 24px 0 8px; }
h3 { font-size: 15px; margin: 20px 0 6px; }
.muted { color: var(--muted); font-size: 13px; }

/* ----- app header ----- */
.app-header { position: sticky; top: 0; z-index: 30; background: var(--header-bg); color: var(--header-ink); border-bottom: 1px solid var(--border); }
.app-header .bar { max-width: 1320px; margin: 0 auto; display: flex; align-items: center; gap: 16px; padding: 11px 28px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 750; font-size: 16px; letter-spacing: -.02em; color: var(--header-ink); text-decoration: none; }
.brand .mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: 15px; box-shadow: 0 1px 3px rgba(0,0,0,.18); }
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
.stats { display: flex; gap: 9px; margin-bottom: 16px; flex-wrap: wrap; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 11px; padding: 9px 15px; font-size: 12.5px; color: var(--muted); }
.stat b { color: var(--ink); font-size: 15px; font-weight: 730; margin-right: 6px; }

/* ----- inbox list ----- */
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); overflow: hidden; }
.lead { display: flex; align-items: center; gap: 16px; padding: 14px 18px; border-bottom: 1px solid var(--hairline); }
.lead:last-child { border-bottom: 0; }
.lead:hover { background: var(--row-hover); }
.lead.is-hidden { display: none; }
.lead-main { flex: 1 1 auto; min-width: 0; }
.lead-co { font-weight: 680; font-size: 14.5px; letter-spacing: -.01em; }
.lead-role { color: var(--muted); font-size: 13px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lead-meta { display: flex; gap: 14px; margin-top: 6px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.lead-meta span { white-space: nowrap; }
.lead-act { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }

/* ----- filter bar (reuses col-filter/col-dropdown JS) ----- */
.filter-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; flex-wrap: wrap; }
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
.add-form { display: none; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; margin: 0 0 16px; }
.add-form.open { display: block; }
.add-form .add-row { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.add-form input[type=url], .add-form input[type=text] { padding: 9px 12px; border: 1px solid var(--border); border-radius: 9px; font-size: 13.5px; font-family: inherit; background: var(--surface); color: var(--ink); }
.add-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.row-deleting { opacity: 0; transition: opacity 0.2s; }

/* ----- batch banner ----- */
.btn-batch { background: var(--accent); color: var(--accent-ink); border: 0; padding: 8px 16px; border-radius: 10px; font-size: 13px; cursor: pointer; font-weight: 600; font-family: inherit; transition: opacity .15s ease; }
.btn-batch:hover { opacity: .92; }
.btn-batch:disabled { opacity: .55; cursor: default; }
.batch-banner { display: none; align-items: center; gap: 10px; padding: 11px 16px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--ink); font-size: 14px; transition: background .2s ease, color .2s ease; }
.batch-banner.show { display: flex; }
.batch-banner .batch-icon { font-size: 15px; line-height: 1; flex-shrink: 0; }
.batch-banner .batch-msg { font-weight: 600; }
.batch-banner .batch-elapsed { opacity: .65; font-size: 13px; }
.batch-banner a { color: var(--accent); font-weight: 700; text-decoration: underline; }
.batch-banner .btn-batch { margin-left: auto; }
.batch-banner.is-running { background: var(--mid-bg); border-color: transparent; color: var(--mid-ink); }
.batch-banner.is-done    { background: var(--good-bg); border-color: transparent; color: var(--good-ink); }
.batch-banner.is-failed  { background: var(--warn-bg); border-color: transparent; color: var(--warn-ink); }

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
    <a class="brand" href="/?view=inbox"><span class="mark">💼</span> GetTheJob</a>
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
        <a href="/onboarding?preview=1">⚙&nbsp; Settings</a>
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

  let previewTrackerHtml = '<div class="empty">Demo data not found.</div>';
  if (demoAppExists) {
    const { header, rows } = parseApplicationsMd(readFileSync(demoAppPath, 'utf8'));
    const idx = {
      num: header.findIndex(h => h.trim() === '#'),
      date: header.findIndex(h => /^date$/i.test(h)),
      company: header.findIndex(h => /^company$/i.test(h)),
      role: header.findIndex(h => /^role$/i.test(h)),
      score: header.findIndex(h => /^score$/i.test(h)),
      status: header.findIndex(h => /^status$/i.test(h)),
      notes: header.findIndex(h => /^notes$/i.test(h)),
    };
    const tbodyRows = rows.map(r => {
      const status = (r[idx.status] || '').trim();
      const scoreRaw = r[idx.score] || '';
      const rowClass = ['Applied','Rejected','Discarded'].includes(status) ? `row-${status.toLowerCase()}` : '';
      return `<tr class="${rowClass}">
        <td>${escapeHtml(r[idx.num] || '')}</td>
        <td>${escapeHtml(r[idx.date] || '')}</td>
        <td><strong>${escapeHtml(r[idx.company] || '')}</strong></td>
        <td>${escapeHtml(r[idx.role] || '')}</td>
        <td><span class="score-pill ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw)}</span></td>
        <td>${escapeHtml(status)}</td>
        <td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r[idx.notes] || '')}</td>
      </tr>`;
    }).join('');
    previewTrackerHtml = `<table><thead><tr><th>#</th><th>Date</th><th>Company</th><th>Role</th><th>Score</th><th>Status</th><th>Notes</th></tr></thead><tbody>${tbodyRows}</tbody></table>`;
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
    const sorted = rows.slice().sort((a, b) => parseFloat(b[idx.score]) - parseFloat(a[idx.score]));
    const tbodyRows = sorted.map(r => {
      const v = (r[idx.verdict] || '').trim();
      return `<tr>
        <td><span class="score-pill ${scoreClass(r[idx.score])}">${escapeHtml(r[idx.score])}</span></td>
        <td><span class="verdict-pill ${verdictClass(v)}">${escapeHtml(v)}</span></td>
        <td><strong>${escapeHtml(r[idx.company] || '')}</strong></td>
        <td>${escapeHtml(r[idx.role] || '')}</td>
        <td>${escapeHtml(r[idx.location] || '')}</td>
        <td class="muted">${escapeHtml(r[idx.note] || '')}</td>
      </tr>`;
    }).join('');
    previewTriageHtml = `<table><thead><tr><th>Score</th><th>Verdict</th><th>Company</th><th>Role</th><th>Location</th><th>Note</th></tr></thead><tbody>${tbodyRows}</tbody></table>`;
  }

  const industriesJson = JSON.stringify(INDUSTRIES);
  const roleSuggestionsJson = JSON.stringify(ROLE_SUGGESTIONS);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GetTheJob — Setup</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💼</text></svg>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${CSS}
.onboarding { max-width: 1100px; margin: 0 auto; padding: 20px 32px 40px; }
.ob-step[data-step="1"], .ob-step[data-step="2"], .ob-step[data-step="3"], .ob-step[data-step="4"], .ob-step[data-step="5"] { max-width: 800px; margin: 0 auto; }
.ob-hero { text-align: center; margin-bottom: 12px; }
.ob-hero h1 { font-size: 26px; margin: 0 0 4px; }
.ob-hero .ob-icon { font-size: 32px; margin-bottom: 4px; }
.ob-hero p { color: var(--muted); font-size: 14px; margin: 0; }
.ob-step { display: none; }
.ob-step.active { display: block; }
.ob-progress { display: flex; justify-content: center; gap: 8px; margin: 0 0 32px; }
.ob-progress .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); transition: background 0.2s; }
.ob-progress .dot.done { background: var(--high); }
.ob-progress .dot.current { background: var(--accent); }
.ob-btn { display: inline-block; padding: 10px 28px; border-radius: 8px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.15s, opacity 0.15s; }
.ob-btn-primary { background: var(--accent); color: #fff; }
.ob-btn-primary:hover { opacity: 0.9; }
.ob-btn-secondary { background: #fff; color: var(--fg); border: 1px solid var(--border); }
.ob-btn-secondary:hover { background: var(--row-alt); }
.ob-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ob-actions { display: flex; justify-content: space-between; margin-top: 32px; }
.ob-cards { display: flex; gap: 16px; margin-bottom: 8px; }
.ob-card { flex: 1; text-align: center; padding: 16px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.ob-card-ic { font-size: 24px; margin-bottom: 8px; }
.ob-card strong { font-size: 14px; }
.ob-card p { color: var(--muted); font-size: 12px; margin: 5px 0 0; line-height: 1.45; }
.ob-cta { text-align: center; margin: 28px 0 34px; }
.ob-btn-lg { padding: 14px 42px; font-size: 16px; border-radius: 12px; box-shadow: 0 1px 2px rgba(40,30,20,.06), 0 8px 22px rgba(40,30,20,.12); }
.ob-cta .ob-manual { display: block; margin-top: 14px; font-size: 13px; color: var(--muted); text-decoration: none; }
.ob-cta .ob-manual:hover { text-decoration: underline; color: var(--ink); }
.ob-preview-caption { text-align: center; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; margin: 0 0 12px; }
.ob-field { margin-bottom: 20px; }
.ob-field label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.ob-field .ob-hint { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.ob-field input, .ob-field textarea, .ob-field select { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; font-family: inherit; background: #fff; }
.ob-field input:focus, .ob-field textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.ob-field textarea { min-height: 200px; font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace; font-size: 13px; }
.ob-row { display: flex; gap: 16px; }
.ob-row > .ob-field { flex: 1; }
.ob-industry-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-top: 8px; }
.ob-industry-card { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 2px solid var(--border); border-radius: 8px; cursor: pointer; transition: border-color 0.15s, background 0.15s; user-select: none; font-size: 14px; }
.ob-industry-card:hover { border-color: var(--accent); background: var(--accent-weak); }
.ob-industry-card.selected { border-color: var(--accent); background: var(--accent-weak); }
.ob-industry-card .ob-ic-icon { font-size: 22px; }
.ob-industry-card .ob-ic-check { display: none; margin-left: auto; color: var(--accent); font-size: 16px; font-weight: 700; }
.ob-industry-card.selected .ob-ic-check { display: inline; }
.ob-tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; min-height: 42px; cursor: text; }
.ob-tags:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.ob-tag { display: inline-flex; align-items: center; gap: 4px; background: var(--score-mid-bg); color: var(--accent); padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 500; }
.ob-tag button { background: none; border: none; cursor: pointer; color: var(--accent); font-size: 14px; padding: 0; line-height: 1; opacity: 0.6; }
.ob-tag button:hover { opacity: 1; }
.ob-tags input { border: none; outline: none; flex: 1; min-width: 120px; font-size: 14px; padding: 2px 4px; background: transparent; }
.ob-suggestions { position: absolute; z-index: 20; background: #fff; border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); max-height: 200px; overflow-y: auto; display: none; }
.ob-suggestions.open { display: block; }
.ob-suggestions div { padding: 8px 12px; cursor: pointer; font-size: 13px; }
.ob-suggestions div:hover, .ob-suggestions div.highlighted { background: var(--row-alt); }
.ob-preview-tabs { display: flex; gap: 0; margin-bottom: 0; }
.ob-preview-tab { padding: 8px 20px; border: 1px solid var(--border); border-bottom: none; border-radius: 6px 6px 0 0; cursor: pointer; font-size: 13px; font-weight: 500; background: var(--row-alt); color: var(--muted); }
.ob-preview-tab.active { background: #fff; color: var(--fg); border-bottom-color: #fff; position: relative; z-index: 1; }
.ob-preview-panel { border: 1px solid var(--border); border-radius: 0 6px 6px 6px; background: #fff; padding: 0; max-height: 260px; overflow: auto; position: relative; top: -1px; }
.ob-preview-panel table { font-size: 12.5px; border-collapse: separate; border-spacing: 0; }
.ob-preview-panel thead th { position: sticky; top: 0; background: #fff; z-index: 2; padding: 8px 6px; border-bottom: 2px solid var(--border); }
.ob-preview-panel .disabled-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 5; }
.ob-preview-wrap { position: relative; }
.ob-upload-zone { border: 2px dashed var(--border); border-radius: 8px; padding: 40px 20px; text-align: center; cursor: pointer; transition: border-color 0.15s, background 0.15s; margin-bottom: 16px; }
.ob-upload-zone:hover, .ob-upload-zone.dragover { border-color: var(--accent); background: var(--accent-weak); }
.ob-upload-zone .ob-upload-icon { font-size: 36px; margin-bottom: 8px; }
.ob-upload-zone p { margin: 4px 0; color: var(--muted); font-size: 14px; }
.ob-upload-zone .ob-upload-name { color: var(--high); font-weight: 600; }
.ob-comp-row { display: flex; gap: 12px; align-items: end; }
.ob-comp-row > .ob-field:first-child { flex: 2; }
.ob-comp-row > .ob-field:last-child { flex: 1; }
.ob-done-check { display: flex; align-items: center; gap: 10px; padding: 10px 0; font-size: 14px; }
.ob-done-check .ob-check { color: var(--high); font-size: 18px; }
.ob-done-check .ob-skip { color: var(--muted); font-size: 18px; }
.ob-section-title { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: var(--fg); }
.ob-or-divider { text-align: center; color: var(--muted); font-size: 13px; margin: 16px 0; }
.ob-done-actions { display: flex; gap: 12px; justify-content: center; margin-top: 24px; }
</style>
</head>
<body>
<main class="onboarding">

<!-- Step 0: Welcome + Preview -->
<div class="ob-step active" data-step="0">
  <div class="ob-hero">
    <div class="ob-icon">💼</div>
    <h1>Ready to get the job?</h1>
    <p>Your entire job search in one place — from first scan to signed offer.</p>
  </div>
  <div class="ob-cards">
    <div class="ob-card"><div class="ob-card-ic">🔍</div><strong>Scan &amp; Score</strong><p>Discovers open roles and scores each one against your profile.</p></div>
    <div class="ob-card"><div class="ob-card-ic">📄</div><strong>Tailored Apply Packs</strong><p>Generates a custom resume, cover letter, and application answers for every role.</p></div>
    <div class="ob-card"><div class="ob-card-ic">📋</div><strong>Track Everything</strong><p>One dashboard from application to offer. Never lose track.</p></div>
  </div>
  <div class="ob-cta">
    <button class="ob-btn ob-btn-primary ob-btn-lg" onclick="goStep(1)">Get Started →</button>
    <a class="ob-manual" href="https://github.com/adrianmb0/GetTheJob#first-time-setup-manual" target="_blank">I prefer to set up manually</a>
  </div>
  <div class="ob-prereq muted" style="text-align:center;font-size:12.5px;margin:14px auto 0;max-width:560px;line-height:1.5">⚙️ Runs on <a href="https://claude.com/claude-code" target="_blank" rel="noopener">Claude Code</a> with a Claude Pro or Max plan (or API key). Scanning &amp; tracking are free — AI scoring and apply packs use your plan.</div>
  <div class="ob-preview-caption">A peek at your dashboard</div>
  <div class="ob-preview-tabs" style="margin:0">
    <div class="ob-preview-tab active" onclick="switchPreview('tracker')">Pipeline</div>
    <div class="ob-preview-tab" onclick="switchPreview('triage')">Inbox</div>
  </div>
  <div class="ob-preview-wrap">
    <div class="disabled-overlay"></div>
    <div class="ob-preview-panel" id="preview-tracker">${previewTrackerHtml}</div>
    <div class="ob-preview-panel" id="preview-triage" style="display:none">${previewTriageHtml}</div>
  </div>
</div>

<!-- Step 1: Profile -->
<div class="ob-step" data-step="1">
  <div class="ob-progress"><div class="dot current"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
  <h2 style="text-align:center;margin-top:0">About You</h2>
  <p class="muted" style="text-align:center">Basic info for your profile. You can always edit this later.</p>
  <div class="ob-row">
    <div class="ob-field"><label>Full Name</label><input type="text" id="ob-name" placeholder="Jane Smith"></div>
    <div class="ob-field"><label>Email</label><input type="email" id="ob-email" placeholder="jane@example.com"></div>
  </div>
  <div class="ob-row">
    <div class="ob-field"><label>Location</label><input type="text" id="ob-location" placeholder="San Francisco, CA"></div>
    <div class="ob-field"><label>LinkedIn <span style="font-weight:400;color:var(--muted)">(optional)</span></label><input type="text" id="ob-linkedin" placeholder="linkedin.com/in/yourname"></div>
  </div>
  <div class="ob-actions">
    <button class="ob-btn ob-btn-secondary" onclick="goStep(0)">Back</button>
    <button class="ob-btn ob-btn-primary" onclick="goStep(2)">Next</button>
  </div>
</div>

<!-- Step 2: Industry, Roles, Comp -->
<div class="ob-step" data-step="2">
  <div class="ob-progress"><div class="dot done"></div><div class="dot current"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
  <h2 style="text-align:center;margin-top:0">What Are You Looking For?</h2>
  <p class="muted" style="text-align:center">Select your field and target roles so we can find the right jobs for you.</p>

  <div class="ob-section-title">Industry / Field</div>
  <div class="ob-industry-grid" id="ob-industries">
    ${INDUSTRIES.map(ind => `<div class="ob-industry-card" data-id="${ind.id}" onclick="toggleIndustry(this)"><span class="ob-ic-icon">${ind.icon}</span><span>${escapeHtml(ind.label)}</span><span class="ob-ic-check">✓</span></div>`).join('')}
    <div id="ob-other-input" style="display:none;margin-top:8px"><input type="text" id="ob-other-text" placeholder="Describe your field (e.g. Nonprofit, Aerospace...)" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px"></div>
  </div>

  <div class="ob-section-title" style="margin-top:28px">Target Roles</div>
  <div class="ob-hint" style="font-size:12px;color:var(--muted);margin-bottom:6px">Type a role and press Enter. Suggestions update based on your selected industries.</div>
  <div style="position:relative">
    <div class="ob-tags" id="ob-roles-container" onclick="document.getElementById('ob-roles-input').focus()">
      <input type="text" id="ob-roles-input" placeholder="e.g. Product Manager, Data Analyst..." autocomplete="off">
    </div>
    <div class="ob-suggestions" id="ob-roles-suggestions"></div>
  </div>

  <div class="ob-section-title" style="margin-top:28px">Compensation Target <span style="font-weight:400;color:var(--muted)">(optional)</span></div>
  <div class="ob-comp-row">
    <div class="ob-field" style="margin:0"><input type="text" id="ob-comp" placeholder="$120K-180K"></div>
    <div class="ob-field" style="margin:0">
      <select id="ob-currency"><option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="CHF">CHF</option><option value="CAD">CAD</option><option value="AUD">AUD</option><option value="Other">Other</option></select>
    </div>
  </div>

  <div class="ob-actions">
    <button class="ob-btn ob-btn-secondary" onclick="goStep(1)">Back</button>
    <button class="ob-btn ob-btn-primary" onclick="goStep(3)">Next</button>
  </div>
</div>

<!-- Step 3: CV -->
<div class="ob-step" data-step="3">
  <div class="ob-progress"><div class="dot done"></div><div class="dot done"></div><div class="dot current"></div><div class="dot"></div><div class="dot"></div></div>
  <h2 style="text-align:center;margin-top:0">Your Resume</h2>
  <p class="muted" style="text-align:center">Upload your resume or paste it below. This helps score job fit and generate tailored applications.</p>

  <div class="ob-upload-zone" id="ob-upload-zone">
    <div class="ob-upload-icon">📄</div>
    <p><strong>Drop your resume here</strong> or click to browse</p>
    <p style="font-size:12px">Supports PDF files</p>
    <p class="ob-upload-name" id="ob-upload-name" style="display:none"></p>
    <input type="file" id="ob-file-input" accept=".pdf" style="display:none">
  </div>

  <div class="ob-or-divider">— or paste as Markdown —</div>

  <div class="ob-field">
    <textarea id="ob-cv" placeholder="# Your Name&#10;&#10;**Location:** City, State&#10;**Email:** you@example.com&#10;&#10;## Professional Summary&#10;&#10;Brief description of your background...&#10;&#10;## Work Experience&#10;&#10;### Company — Role&#10;*2022-Present*&#10;&#10;- Key achievement 1&#10;- Key achievement 2"></textarea>
  </div>

  <div class="ob-actions">
    <button class="ob-btn ob-btn-secondary" onclick="goStep(2)">Back</button>
    <button class="ob-btn ob-btn-primary" onclick="goStep(4)">Next</button>
    <button class="ob-btn ob-btn-secondary" onclick="state.skipCv=true;goStep(4)" style="font-size:13px">Skip CV for now</button>
  </div>
</div>

<!-- Step 4: Your Story (optional but valuable) -->
<div class="ob-step" data-step="4">
  <div class="ob-progress"><div class="dot done"></div><div class="dot done"></div><div class="dot done"></div><div class="dot current"></div><div class="dot"></div></div>
  <h2 style="text-align:center;margin-top:0">Your Story</h2>
  <p class="muted" style="text-align:center">This powers your cover letters and tailored applications. Skip now and add later if you prefer.</p>

  <div class="ob-field">
    <label>Professional headline</label>
    <div class="ob-hint">One line that describes who you are. Used as the opening of cover letters.</div>
    <input type="text" id="ob-headline" placeholder="e.g. ML Engineer turned AI product builder">
  </div>

  <div class="ob-field">
    <label>Why are you looking? <span style="font-weight:400;color:var(--muted)">(your exit story)</span></label>
    <div class="ob-hint">1-2 sentences on what drives your search. This gets woven into cover letters to explain your motivation.</div>
    <textarea id="ob-exit-story" style="min-height:60px" placeholder="e.g. After 5 years building and scaling a SaaS product, I'm looking to apply that experience at a company working on AI infrastructure."></textarea>
  </div>

  <div class="ob-field">
    <label>Top strengths <span style="font-weight:400;color:var(--muted)">(superpowers)</span></label>
    <div class="ob-hint">3-5 things you're best at. These become bullet points in your tailored materials.</div>
    <div class="ob-tags" id="ob-strengths-container" onclick="document.getElementById('ob-strengths-input').focus()">
      <input type="text" id="ob-strengths-input" placeholder="Type a strength and press Enter..." autocomplete="off">
    </div>
  </div>

  <div class="ob-field">
    <label>Key project or achievement <span style="font-weight:400;color:var(--muted)">(proof point)</span></label>
    <div class="ob-hint">Your best "STAR story" — a project with measurable impact. Used in cover letters and interview prep.</div>
    <div class="ob-row">
      <div class="ob-field" style="flex:2;margin:0"><input type="text" id="ob-proof-name" placeholder="Project or achievement name"></div>
      <div class="ob-field" style="flex:1;margin:0"><input type="text" id="ob-proof-metric" placeholder="Impact metric (e.g. 40% faster)"></div>
    </div>
    <textarea id="ob-proof-detail" style="min-height:50px;margin-top:8px" placeholder="Brief description: what you built, what problem it solved, and the result."></textarea>
  </div>

  <div class="ob-actions">
    <button class="ob-btn ob-btn-secondary" onclick="goStep(3)">Back</button>
    <button class="ob-btn ob-btn-primary" onclick="completeOnboarding(false, this)">Finish Setup</button>
    <button class="ob-btn ob-btn-secondary" onclick="goStep(5);completeOnboarding(true, this)" style="font-size:13px">Skip for now</button>
  </div>
</div>

<!-- Step 5: Done + First Scan -->
<div class="ob-step" data-step="5">
  <div class="ob-progress"><div class="dot done"></div><div class="dot done"></div><div class="dot done"></div><div class="dot done"></div><div class="dot done"></div></div>
  <div style="text-align:center;margin-bottom:24px">
    <div style="font-size:36px;margin-bottom:4px">🎉</div>
    <h2 style="margin:0 0 8px">You're All Set!</h2>
    <p class="muted">Your workspace is configured and ready to go.</p>
  </div>
  <div id="ob-done-list"></div>
  <div class="ob-done-actions" style="flex-direction:column;align-items:center;gap:8px">
    <button class="ob-btn ob-btn-primary" onclick="runFirstScan(this)" id="ob-scan-btn" style="padding:12px 32px;font-size:15px">Run Your First Scan</button>
    <p class="muted" style="font-size:12px;margin:0">Discovers jobs matching your profile — takes about a minute.</p>
    <a href="/" style="color:var(--muted);font-size:13px;margin-top:4px">Skip and go to dashboard</a>
  </div>
  <div id="ob-scan-progress" style="display:none;text-align:center;margin-top:16px">
    <p id="ob-scan-status" style="font-size:14px">Scanning job boards...</p>
    <div style="width:200px;height:4px;background:var(--border);border-radius:2px;margin:8px auto"><div id="ob-scan-bar" style="height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 0.5s"></div></div>
  </div>
  <div style="margin-top:32px;padding:20px;background:var(--bg-alt);border:1px solid var(--border);border-radius:12px;text-align:center">
    <div style="font-size:28px;margin-bottom:6px">💼</div>
    <p style="font-weight:600;margin:0 0 6px;font-size:15px">Add to your Dock for one-click access</p>
    <p class="muted" style="font-size:13px;margin:0 0 12px;line-height:1.5">Open Finder → <code style="background:var(--border);padding:2px 6px;border-radius:4px">GetTheJob.app</code> (in the project folder) → drag it to your Dock.<br>One click launches the dashboard and runs your morning batch automatically.</p>
    <p class="muted" style="font-size:12px;margin:0;opacity:.7">Requires <a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" style="color:var(--accent)">Claude Code</a> for AI-powered triage.</p>
  </div>
</div>

</main>

<script>
const INDUSTRIES = ${industriesJson};
const ROLE_SUGGESTIONS = ${roleSuggestionsJson};
const PREVIEW_MODE = ${previewMode ? 'true' : 'false'};

const state = {
  step: 0,
  industries: [],
  roles: [],
  strengths: [],
  uploadedFile: null,
  uploadedFileName: '',
  skipCv: false,
};

function goStep(n) {
  if (n === 2 && state.step === 1) {
    if (!document.getElementById('ob-name').value.trim()) {
      document.getElementById('ob-name').focus();
      return;
    }
    if (!document.getElementById('ob-email').value.trim()) {
      document.getElementById('ob-email').focus();
      return;
    }
  }
  document.querySelectorAll('.ob-step').forEach(el => el.classList.remove('active'));
  document.querySelector('[data-step="' + n + '"]').classList.add('active');
  state.step = n;
  window.scrollTo(0, 0);
}

function switchPreview(view) {
  document.querySelectorAll('.ob-preview-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('preview-tracker').style.display = view === 'tracker' ? '' : 'none';
  document.getElementById('preview-triage').style.display = view === 'triage' ? '' : 'none';
  event.target.classList.add('active');
}

function toggleIndustry(el) {
  const id = el.dataset.id;
  el.classList.toggle('selected');
  if (el.classList.contains('selected')) {
    if (!state.industries.includes(id)) state.industries.push(id);
  } else {
    state.industries = state.industries.filter(i => i !== id);
  }
  const otherInput = document.getElementById('ob-other-input');
  if (otherInput) otherInput.style.display = state.industries.includes('other') ? '' : 'none';
  updateSuggestions();
}

function addRole(role) {
  role = role.trim();
  if (!role || state.roles.includes(role)) return;
  state.roles.push(role);
  const tag = document.createElement('span');
  tag.className = 'ob-tag';
  tag.innerHTML = role + '<button onclick="removeRole(this, \\'' + role.replace(/'/g, "\\\\'") + '\\')">&times;</button>';
  const input = document.getElementById('ob-roles-input');
  input.parentNode.insertBefore(tag, input);
  input.value = '';
  closeSuggestions();
}

function removeRole(btn, role) {
  state.roles = state.roles.filter(r => r !== role);
  btn.parentNode.remove();
}

let sugHighlight = -1;
function updateSuggestions() {
  const input = document.getElementById('ob-roles-input');
  const val = input.value.trim().toLowerCase();
  if (!val) { closeSuggestions(); return; }
  let all = [];
  const sources = state.industries.length > 0 ? state.industries : Object.keys(ROLE_SUGGESTIONS);
  sources.forEach(id => { if (ROLE_SUGGESTIONS[id]) all = all.concat(ROLE_SUGGESTIONS[id]); });
  all = [...new Set(all)].filter(r => r.toLowerCase().includes(val) && !state.roles.includes(r)).slice(0, 8);
  const box = document.getElementById('ob-roles-suggestions');
  if (all.length === 0) { closeSuggestions(); return; }
  sugHighlight = -1;
  box.innerHTML = all.map((r, i) => '<div data-idx="' + i + '" onmousedown="addRole(\\'' + r.replace(/'/g, "\\\\'") + '\\')">' + r + '</div>').join('');
  box.classList.add('open');
  const rect = document.getElementById('ob-roles-container').getBoundingClientRect();
  box.style.width = rect.width + 'px';
  box.style.left = '0';
  box.style.top = (rect.height + 4) + 'px';
}

function closeSuggestions() {
  document.getElementById('ob-roles-suggestions').classList.remove('open');
  sugHighlight = -1;
}

const rolesInput = document.getElementById('ob-roles-input');
rolesInput.addEventListener('input', updateSuggestions);
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
  else if (e.key === 'Backspace' && !rolesInput.value && state.roles.length > 0) {
    const last = state.roles.pop();
    const tags = document.querySelectorAll('.ob-tag');
    if (tags.length) tags[tags.length - 1].remove();
  }
});
rolesInput.addEventListener('blur', () => setTimeout(closeSuggestions, 150));

function highlightSug(items) {
  items.forEach((el, i) => el.classList.toggle('highlighted', i === sugHighlight));
}

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
  if (!file.name.toLowerCase().endsWith('.pdf')) { alert('Please upload a PDF file.'); return; }
  state.uploadedFile = file;
  state.uploadedFileName = file.name;
  const nameEl = document.getElementById('ob-upload-name');
  nameEl.textContent = '✓ ' + file.name;
  nameEl.style.display = '';
}

// Strengths tag input
function removeStrength(btn, val) { state.strengths = state.strengths.filter(s => s !== val); btn.parentNode.remove(); }
const strengthsInput = document.getElementById('ob-strengths-input');
if (strengthsInput) {
  strengthsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = strengthsInput.value.trim();
      if (!val || state.strengths.includes(val)) return;
      state.strengths.push(val);
      const tag = document.createElement('span');
      tag.className = 'ob-tag';
      tag.textContent = val;
      const x = document.createElement('button');
      x.textContent = '×';
      x.onclick = function() { removeStrength(this, val); };
      tag.appendChild(x);
      strengthsInput.parentNode.insertBefore(tag, strengthsInput);
      strengthsInput.value = '';
    }
    if (e.key === 'Backspace' && !strengthsInput.value && state.strengths.length > 0) {
      state.strengths.pop();
      const tags = document.querySelectorAll('#ob-strengths-container .ob-tag');
      if (tags.length) tags[tags.length - 1].remove();
    }
  });
}

async function runFirstScan(btn) {
  if (PREVIEW_MODE) {
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    document.getElementById('ob-scan-progress').style.display = '';
    const bar = document.getElementById('ob-scan-bar');
    let pct = 0;
    const iv = setInterval(() => { pct = Math.min(pct + 20, 100); bar.style.width = pct + '%'; }, 400);
    setTimeout(() => {
      clearInterval(iv);
      bar.style.width = '100%';
      document.getElementById('ob-scan-status').textContent = 'Preview complete — no scan was run.';
      btn.style.display = 'none';
    }, 2500);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  document.getElementById('ob-scan-progress').style.display = '';
  const bar = document.getElementById('ob-scan-bar');
  try {
    const res = await fetch('/api/run-scan', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) { document.getElementById('ob-scan-status').textContent = 'Scan failed: ' + (data.error || 'unknown'); return; }
    let pct = 10;
    bar.style.width = '10%';
    const poll = setInterval(async () => {
      try {
        const sr = await fetch('/api/scan-status');
        const sd = await sr.json();
        pct = Math.min(pct + 10, 90);
        bar.style.width = pct + '%';
        if (!sd.running) {
          clearInterval(poll);
          bar.style.width = '100%';
          document.getElementById('ob-scan-status').innerHTML = 'Done! <a href="/triage" style="color:var(--accent);font-weight:600">View your results →</a>';
          btn.style.display = 'none';
        }
      } catch (e) { /* keep polling */ }
    }, 3000);
  } catch (e) {
    document.getElementById('ob-scan-status').textContent = 'Scan failed: ' + e.message;
  }
}

async function completeOnboarding(skipStory, btn) {
  if (btn) { btn.disabled = true; btn.textContent = PREVIEW_MODE ? 'Preview...' : 'Setting up...'; }

  const skipCv = state.skipCv;
  const headline = (document.getElementById('ob-headline')?.value || '').trim();
  const exitStory = (document.getElementById('ob-exit-story')?.value || '').trim();
  const proofName = (document.getElementById('ob-proof-name')?.value || '').trim();
  const proofMetric = (document.getElementById('ob-proof-metric')?.value || '').trim();
  const proofDetail = (document.getElementById('ob-proof-detail')?.value || '').trim();
  const hasNarrative = !skipStory && (headline || exitStory || state.strengths.length > 0 || proofName);

  const buildDoneList = () => {
    const hasCv = !skipCv && (!!document.getElementById('ob-cv')?.value?.trim() || !!state.uploadedFile);
    const list = document.getElementById('ob-done-list');
    list.innerHTML = [
      { label: 'Profile (config/profile.yml)', ok: true },
      { label: 'Job preferences (portals.yml)', ok: true },
      { label: 'Resume (cv.md)', ok: hasCv },
      { label: 'Cover letter narrative', ok: hasNarrative },
    ].map(item =>
      '<div class="ob-done-check"><span class="' + (item.ok ? 'ob-check' : 'ob-skip') + '">' + (item.ok ? '✓' : '⏭') + '</span> ' + item.label + (item.ok ? '' : ' <span class="muted">— add later in config/profile.yml</span>') + '</div>'
    ).join('');
  };

  if (PREVIEW_MODE) {
    buildDoneList();
    const actionsEl = document.querySelector('[data-step="5"] .ob-done-actions');
    if (actionsEl) actionsEl.innerHTML = '<a href="/" class="ob-btn ob-btn-secondary" style="text-decoration:none">Back to Dashboard</a><span class="muted" style="padding:10px">Preview complete — no files were changed.</span>';
    goStep(5);
    return;
  }

  const payload = {
    name: document.getElementById('ob-name').value.trim(),
    email: document.getElementById('ob-email').value.trim(),
    location: document.getElementById('ob-location').value.trim(),
    linkedin: document.getElementById('ob-linkedin').value.trim(),
    industries: state.industries,
    roles: state.roles,
    comp: document.getElementById('ob-comp').value.trim(),
    currency: document.getElementById('ob-currency').value,
    cv: skipCv ? '' : document.getElementById('ob-cv').value,
    headline: headline,
    exitStory: exitStory,
    strengths: state.strengths,
    proofName: proofName,
    proofMetric: proofMetric,
    proofDetail: proofDetail,
  };

  if (state.uploadedFile && !skipCv) {
    const formData = new FormData();
    formData.append('pdf', state.uploadedFile);
    formData.append('payload', JSON.stringify(payload));
    try {
      const res = await fetch('/api/onboarding/complete', { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.ok) { alert('Setup failed: ' + (data.error || 'unknown')); if (btn) { btn.disabled = false; btn.textContent = 'Finish Setup'; } return; }
    } catch (e) { alert('Setup failed: ' + e.message); if (btn) { btn.disabled = false; btn.textContent = 'Finish Setup'; } return; }
  } else {
    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) { alert('Setup failed: ' + (data.error || 'unknown')); if (btn) { btn.disabled = false; btn.textContent = 'Finish Setup'; } return; }
    } catch (e) { alert('Setup failed: ' + e.message); if (btn) { btn.disabled = false; btn.textContent = 'Finish Setup'; } return; }
  }

  buildDoneList();
  goStep(5);
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
  'Offer', 'Rejected', 'Discarded', 'SKIP'
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
  // Match output/<file>.pdf in any link target. Strip any "../../" prefix.
  const re = /output\/((?:cv|cover)-[a-zA-Z0-9._-]+\.pdf)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const file = m[1];
    if (file.startsWith('cv-') && !out.cv) out.cv = file;
    if (file.startsWith('cover-') && !out.cover) out.cover = file;
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
  /* widen container on the apply page so the answers fill the viewport */
  main.container:has(.apply-answers-full) { max-width: none; padding-left: 32px; padding-right: 32px; }
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
  if (!/^[a-zA-Z0-9._-]+\.pdf$/.test(file)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid file');
    return;
  }
  const abs = join(ROOT, 'output', file);
  if (!existsSync(abs)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const stat = statSync(abs);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${file}"`,
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
  // "New" = rows added to the pipeline on the most recent date present
  const addedDates = rows.map(r => (r[idx.date] || '').trim()).filter(Boolean).sort();
  const latestAdded = addedDates.length ? addedDates[addedDates.length - 1] : '';
  const newCount = latestAdded ? rows.filter(r => (r[idx.date] || '').trim() === latestAdded).length : 0;

  // Display columns (forward funnel). Closed states live in a collapsible lane.
  const COLS = [
    { key: 'Reviewing',   dot: 'var(--neutral-ink)', statuses: ['Evaluated'] },
    { key: 'Shortlisted', dot: '#C99A2E',            statuses: ['Shortlisted'] },
    { key: 'Applied',     dot: 'var(--accent)',      statuses: ['Applied', 'Responded'] },
    { key: 'Interview',   dot: '#8B5CF6',            statuses: ['Interview'] },
    { key: 'Offer',       dot: '#3A6B45',            statuses: ['Offer'] },
  ];
  const CLOSED = ['Rejected', 'Discarded', 'SKIP'];
  const colOf = (status) => {
    if (status === 'Evaluated') return 'Reviewing';
    if (status === 'Responded') return 'Applied';
    if (CLOSED.includes(status)) return 'Closed';
    if (COLS.some(c => c.key === status)) return status;
    return 'Reviewing';
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
    const isNew = !!latestAdded && (r[idx.date] || '').trim() === latestAdded;

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
    return `<div class="col" data-status="${c.statuses[0]}" data-statuses="${c.statuses.join(',')}"><div class="col-h"><span><span class="dot" style="background:${c.dot}"></span>${c.key}</span><span class="c">${cards.length}</span></div>${inner}</div>`;
  }).join('');

  const closedCards = rows.filter(r => CLOSED.includes((r[idx.status] || '').trim()));
  const closedInner = closedCards.length
    ? `<div class="closed-grid">${closedCards.map(card).join('')}</div>`
    : `<div class="kc-empty" style="margin-top:8px">Drag a card here to mark it closed</div>`;
  const closedSummary = closedCards.length
    ? `Closed — ${closedCards.length} (rejected / discarded) · drag a card here to close it`
    : 'Closed · drag a card here to close it';
  const closedHtml = `<details class="closed-lane" data-status="Discarded" data-statuses="${CLOSED.join(',')}"${closedCards.length ? '' : ' open'}><summary>${closedSummary}</summary>${closedInner}</details>`;

  const body = `
<div class="toolbar">
  <div>
    <h1>Pipeline</h1>
    <div class="sub">Everything you're actively pursuing, by stage. Drag a card between columns to move it forward — or click it to open the posting.</div>
  </div>
  <div class="tools">
    ${latestAdded ? `<button class="chip-toggle" id="new-toggle" title="Added to your pipeline on the latest date (${escapeHtml(latestAdded)})">✨ New<span class="chip-count">${newCount}</span></button>` : ''}
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
    t.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; t.classList.add('drop-target'); });
    t.addEventListener('dragleave', e => { if (!t.contains(e.relatedTarget)) t.classList.remove('drop-target'); });
    t.addEventListener('drop', e => {
      e.preventDefault();
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
// so removal doesn't wait for the next morning batch to sweep triage-scores.tsv.
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

function renderInbox(query) {
  const path = join(ROOT, 'data', 'triage-scores.tsv');
  if (!existsSync(path)) {
    return shell('Inbox', '<h1>Inbox</h1><div class="empty">No leads yet — run a scan to populate data/triage-scores.tsv.</div>', { view: 'inbox', ...getCounts() });
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

  // Stat strip figures
  const now = Date.now();
  const WEEK = 7 * 24 * 3600 * 1000;
  let strongCount = 0; const tops = []; let freshCount = 0;
  sorted.forEach(r => {
    const sc = parseFloat(r[idx.score]);
    if (!Number.isNaN(sc) && sc >= 4.0) strongCount++;
    const top = Number(extractComp(r[idx.note] || '').sortKey) || 0;
    if (top > 0) tops.push(top);
    const seen = r[idx.added] || scanHistory.get(r[idx.url] || '') || '';
    const t = Date.parse(seen);
    if (!Number.isNaN(t) && now - t <= WEEK) freshCount++;
  });
  const medianTop = tops.length ? tops.slice().sort((a, b) => a - b)[Math.floor(tops.length / 2)] : 0;

  // "New" = leads from the most recent scan date present (i.e. today, right after a batch runs)
  const addedDates = sorted.map(r => (r[idx.added] || '').trim()).filter(Boolean).sort();
  const latestAdded = addedDates.length ? addedDates[addedDates.length - 1] : '';
  const newCount = latestAdded ? sorted.filter(r => (r[idx.added] || '').trim() === latestAdded).length : 0;

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
    const isNew = !!latestAdded && firstSeen.trim() === latestAdded;
    const sn = parseFloat(scoreNum) || 0;
    const scoreBucket = sn >= 4.5 ? '4.5+' : sn >= 4.0 ? '4.0-4.4' : sn >= 3.5 ? '3.5-3.9' : '<3.5';
    const searchStr = escapeHtml((company + ' ' + role + ' ' + location + ' ' + note).toLowerCase());

    const skipish = /^SKIP/i.test(verdict) || /^SUSPICIOUS/i.test(verdict);
    const shortlistBtn = url
      ? `<button class="btn-shortlist"${skipish ? ' style="background:transparent;border:1px solid var(--border);color:var(--muted)"' : ''} onclick='shortlistJob(${JSON.stringify({ url, company, role, score: scoreRaw, note }).replace(/'/g, "&apos;")}, this)' title="Move to Pipeline as Shortlisted (no evaluation yet)">→ Pipeline</button>`
      : '';
    const openItem = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">↗&nbsp; Open posting</a>` : '';
    const dismissItem = url ? `<button class="danger" onclick="dismissTriage('${escapeHtml(url)}', this)">🗑&nbsp; Dismiss from inbox</button>` : '';

    const metaDate = firstSeen.trim() || datePosted;
    const meta = [
      location ? `<span>${escapeHtml(location)}</span>` : '',
      comp.display ? `<span>${escapeHtml(comp.display)}</span>` : '',
      metaDate ? `<span data-rel="${escapeHtml(metaDate)}" title="Added to your inbox ${escapeHtml(metaDate)}">${escapeHtml(metaDate)}</span>` : '',
    ].filter(Boolean).join('');

    return `<div class="lead${isNew ? ' is-new' : ''}" data-verdict="${escapeHtml(verdict)}" data-score-bucket="${scoreBucket}" data-company="${escapeHtml(company)}" data-location="${escapeHtml(locGroup)}" data-score="${escapeHtml(scoreNum)}" data-pay="${comp.sortKey}" data-posted="${escapeHtml(datePosted)}" data-added="${escapeHtml(firstSeen)}" data-new="${isNew ? '1' : ''}" data-search="${searchStr}">
      <div class="score-chip ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw || '—')}</div>
      <div class="lead-main">
        <div class="lead-co">${escapeHtml(company)}${isNew ? ' <span class="new-badge">NEW</span>' : ''}</div>
        <div class="lead-role">${escapeHtml(role)}</div>
        <div class="lead-meta">${meta}</div>
      </div>
      ${verdict ? `<span class="verdict-pill ${verdictClass(verdict)}">${escapeHtml(verdict)}</span>` : ''}
      <div class="lead-act">
        ${shortlistBtn}
        <div class="menu"><button class="icon-btn" title="More" onclick="toggleMenu(event, this)">⋯</button><div class="menu-pop">${openItem || '<span class="label">No URL on this lead</span>'}${dismissItem}</div></div>
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
  const verdictOpts = verdicts.map(v =>
    `<label data-opt-value="${escapeHtml(v)}"><input type="checkbox" data-value="${escapeHtml(v)}"> <span class="verdict-pill ${verdictClass(v)}">${escapeHtml(v)}</span> <span class="opt-count"></span></label>`
  ).join('');
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
<div id="batch-banner" class="batch-banner">
  <span id="batch-icon" class="batch-icon">⏳</span>
  <span id="batch-msg" class="batch-msg">Morning batch running...</span>
  <span id="batch-elapsed" class="batch-elapsed"></span>
  <button id="batch-run-btn" class="btn-batch" onclick="runBatch(this)" style="display:none">Run Morning Batch</button>
</div>
<script>
(function(){
  const banner=document.getElementById('batch-banner'),icon=document.getElementById('batch-icon'),
    msg=document.getElementById('batch-msg'),elapsed=document.getElementById('batch-elapsed'),
    runBtn=document.getElementById('batch-run-btn');
  let done=false;
  async function poll(){
    try{
      const d=await(await fetch('/api/batch-status')).json();
      let state='';
      if(d.running){
        state='is-running';icon.textContent='⏳';
        msg.textContent='Morning batch running — results will refresh when complete…';
        runBtn.style.display='none';
        if(d.started){const m=Math.floor((Date.now()-new Date(d.started).getTime())/60000);elapsed.textContent=m+'m elapsed';}
      }else{
        // Not running. Build a base message from this session's last exit (if any).
        let base='';
        if(d.exitCode===0){state='is-done';icon.textContent='✅';base='Morning batch complete — <a href="/?view=inbox&new=1">see the new leads</a>';}
        else if(d.exitCode===143||d.exitCode===137){state='';icon.textContent='⏹';base='Morning batch stopped.';}
        else if(d.exitCode!==null){state='is-failed';icon.textContent='⚠️';base='Morning batch failed (exit '+d.exitCode+'). Check the terminal for details.';}
        if(d.cooldownActive){
          // A batch already ran in the last 24h — block, but offer an override.
          const hrs=Math.max(1,Math.ceil(d.cooldownRemainingMs/3600000));
          if(!base){state='';icon.textContent='🌙';base='Morning batch already ran today — next run available in ~'+hrs+'h';}
          else{base+=' · next run in ~'+hrs+'h';}
          runBtn.textContent='Override & run now';runBtn.dataset.override='1';
        }else{
          if(!base){state='';icon.textContent='💡';base='Morning batch available';}
          runBtn.textContent=(d.exitCode!==null?'Run again':'Run Morning Batch');runBtn.dataset.override='';
        }
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
  if(override&&!confirm('A morning batch already ran in the last 24 hours. Run another one now anyway?'))return;
  btn.disabled=true;btn.textContent='Starting...';
  fetch('/api/run-batch'+(override?'?override=1':''),{method:'POST'}).then(r=>r.json()).then(d=>{
    if(d.ok)location.reload();
    else{btn.disabled=false;btn.textContent=label;alert(d.error||'Could not start the batch.');}
  }).catch(()=>{btn.disabled=false;btn.textContent=label;});
}
</script>
<div class="toolbar">
  <div>
    <h1>Inbox</h1>
    <div class="sub">Open roles the scanner found and scored against your profile. Send the strong ones to your pipeline.</div>
  </div>
</div>
<div class="stats">
  <div class="stat"><b>${sorted.length}</b>leads</div>
  <div class="stat"><b>${strongCount}</b>strong (4.0+)</div>
  ${medianTop ? `<div class="stat"><b>$${medianTop}K</b>median top pay</div>` : ''}
  <div class="stat"><b>${freshCount}</b>new this week</div>
</div>
<div class="filter-bar">
  ${latestAdded ? `<button class="chip-toggle" id="new-toggle" title="Leads from the latest scan (${escapeHtml(latestAdded)})">✨ New<span class="chip-count">${newCount}</span></button>` : ''}
  <span class="col-filter" data-col="score-bucket">Score&nbsp;▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear</button>${scoreOpts}</div></span>
  <span class="col-filter" data-col="verdict">Verdict&nbsp;▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear</button>${verdictOpts}</div></span>
  <span class="col-filter" data-col="company">Company&nbsp;▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear</button>${companyOpts}</div></span>
  <span class="col-filter" data-col="location">Location&nbsp;▾<div class="col-dropdown col-dropdown-loc"><button class="col-dropdown-clear">Clear</button>${locationOpts}</div></span>
  <span class="sortctl">Sort <select id="inbox-sort"><option value="score-desc">Score: high → low</option><option value="score-asc">Score: low → high</option><option value="company">Company A–Z</option><option value="pay-desc">Pay: high → low</option><option value="posted-desc">Newest first</option></select></span>
</div>
<div class="muted" id="inbox-summary" style="margin:0 0 12px;min-height:18px"></div>
<div class="panel" id="inbox-list">${leadRows || '<div class="empty">No leads in the inbox.</div>'}</div>
<script>
(function() {
  const STORAGE_KEY = 'getthejob-triage-filters';
  const filterKeys = ['verdict', 'score-bucket', 'company', 'location'];
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

// ----- Morning Batch (auto-runs on startup via claude CLI) -----

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
  } catch (e) { console.log(`[morning-batch] could not persist state: ${e.message}`); }
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

function spawnMorningBatch() {
  if (server._batchProc && !server._batchDone) return false;
  const claudeCheck = spawnSync('which', ['claude']);
  if (claudeCheck.status !== 0) {
    console.log('[morning-batch] claude CLI not found in PATH, skipping');
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
    'run /get-the-job morning-batch'
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
    console.log(`[morning-batch] finished (exit ${code})`);
  });
  proc.on('error', (err) => {
    server._batchDone = true;
    server._batchExit = 1;
    server._batchFinished = new Date().toISOString();
    console.log(`[morning-batch] error: ${err.message}`);
  });
  console.log(`[morning-batch] started`);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    const query = parseQuery(url);

    // First-run: redirect to onboarding if profile.yml doesn't exist
    const profileExists = existsSync(join(ROOT, 'config', 'profile.yml'));
    if (!profileExists && (pathname === '/' || pathname === '/index.html' || pathname === '/triage')) {
      res.writeHead(302, { Location: '/onboarding' });
      res.end();
      return;
    }

    if (pathname === '/onboarding') {
      const isPreview = query.preview === '1';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (profileExists && !isPreview) {
        res.end(shell('Setup', '<h1>Already Set Up</h1><p>Your profile is configured. <a href="/?view=inbox">Go to your dashboard</a>.</p><p class="muted">To reconfigure, delete <code>config/profile.yml</code> and reload this page.</p>'));
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

        const { name, email, location, linkedin, industries, roles, comp, currency, cv } = payload;

        mkdirSync(join(ROOT, 'config'), { recursive: true });
        mkdirSync(join(ROOT, 'data'), { recursive: true });

        const esc = (s) => {
          if (s == null) return '""';
          const v = String(s);
          if (/[:#"'\[\]{},&*?|><!%@`]/.test(v) || v.trim() !== v || v === '') return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
          return '"' + v + '"';
        };

        let profileYml = '# GetTheJob Profile — generated by onboarding wizard\n\n';
        profileYml += 'candidate:\n';
        profileYml += '  full_name: ' + esc(name) + '\n';
        profileYml += '  email: ' + esc(email) + '\n';
        profileYml += '  location: ' + esc(location) + '\n';
        if (linkedin) profileYml += '  linkedin: ' + esc(linkedin) + '\n';
        profileYml += '\ntarget_roles:\n';
        profileYml += '  primary:\n';
        (roles || []).forEach(r => { profileYml += '    - ' + esc(r) + '\n'; });
        if (comp) {
          profileYml += '\ncompensation:\n';
          profileYml += '  target_range: ' + esc(comp) + '\n';
          profileYml += '  currency: ' + esc(currency || 'USD') + '\n';
        }
        const { headline, exitStory, strengths, proofName, proofMetric, proofDetail } = payload;
        if (headline || exitStory || (strengths && strengths.length) || proofName) {
          profileYml += '\nnarrative:\n';
          if (headline) profileYml += '  headline: ' + esc(headline) + '\n';
          if (exitStory) profileYml += '  exit_story: ' + esc(exitStory) + '\n';
          if (strengths && strengths.length) {
            profileYml += '  superpowers:\n';
            strengths.forEach(s => { profileYml += '    - ' + esc(s) + '\n'; });
          }
          if (proofName) {
            profileYml += '  proof_points:\n';
            profileYml += '    - name: ' + esc(proofName) + '\n';
            if (proofMetric) profileYml += '      hero_metric: ' + esc(proofMetric) + '\n';
            if (proofDetail) profileYml += '      description: ' + esc(proofDetail) + '\n';
          }
        }
        writeFileSync(join(ROOT, 'config', 'profile.yml'), profileYml);

        const positive = (roles || []).flatMap(r => r.split(/\s*,\s*|\s+(?:and|or|\/)\s+/i)).filter(Boolean);
        let portalsYml = '# GetTheJob Portals — generated by onboarding wizard\n';
        portalsYml += '# Edit this file to add companies and customize title filters.\n\n';
        portalsYml += 'title_filter:\n';
        portalsYml += '  positive:\n';
        positive.forEach(kw => { portalsYml += '    - ' + esc(kw) + '\n'; });
        portalsYml += '  negative:\n';
        ['Junior', 'Intern', 'Internship'].forEach(kw => { portalsYml += '    - ' + esc(kw) + '\n'; });
        portalsYml += '  seniority_boost:\n';
        ['Senior', 'Staff', 'Principal', 'Lead', 'Head'].forEach(kw => { portalsYml += '    - ' + esc(kw) + '\n'; });
        portalsYml += '\ntracked_companies: []\n';
        portalsYml += '\nsearch_queries: []\n';
        writeFileSync(join(ROOT, 'portals.yml'), portalsYml);

        if (cv) {
          writeFileSync(join(ROOT, 'cv.md'), cv);
        }
        if (pdfBuf) {
          writeFileSync(join(ROOT, 'cv.pdf'), pdfBuf);
        }

        if (!existsSync(join(ROOT, 'data', 'applications.md'))) {
          writeFileSync(join(ROOT, 'data', 'applications.md'),
            '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
        }

        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    // ----- Scan API -----
    if (pathname === '/api/run-scan' && req.method === 'POST') {
      if (server._scanProc && !server._scanDone) return sendJson(res, 409, { ok: false, error: 'scan already running' });
      try {
        server._scanDone = false;
        server._scanExit = null;
        const proc = spawn('node', [join(ROOT, 'scan.mjs')], { cwd: ROOT, stdio: 'ignore' });
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

    // ----- Liveness ping (used by launcher to detect an already-running instance) -----
    if (pathname === '/api/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, app: 'getthejob', pid: process.pid, uptime: Math.round(process.uptime()) });
    }

    // ----- Morning Batch API -----
    if (pathname === '/api/run-batch' && req.method === 'POST') {
      if (server._batchProc && !server._batchDone) return sendJson(res, 409, { ok: false, error: 'morning batch already running' });
      const override = query.override === '1';
      const remaining = batchCooldownRemainingMs();
      if (remaining > 0 && !override) {
        return sendJson(res, 429, {
          ok: false,
          cooldown: true,
          remainingMs: remaining,
          lastRun: readBatchState().lastRun || null,
          error: 'Morning batch already ran in the last 24h. Override to run anyway.',
        });
      }
      const started = spawnMorningBatch();
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

  // Auto-launch morning batch on startup (opt-in via AUTOSTART_BATCH=1).
  // Defaults OFF so restarting the server never kicks off a surprise run;
  // the launcher scripts set AUTOSTART_BATCH=1 to preserve double-click behavior.
  if (process.env.AUTOSTART_BATCH === '1') {
    const remaining = batchCooldownRemainingMs();
    if (remaining > 0) {
      const hrs = (remaining / 3600000).toFixed(1);
      console.log(`  [morning-batch] already ran within the last 24h — skipping auto-start (next in ${hrs}h). Override from the dashboard.`);
    } else {
      const claudeCheck = spawnSync('which', ['claude']);
      if (claudeCheck.status === 0) {
        console.log(`  [morning-batch] claude CLI found — auto-starting...`);
        spawnMorningBatch();
      } else {
        console.log(`  [morning-batch] claude CLI not found — skipping auto-batch`);
      }
    }
  } else {
    console.log(`  [morning-batch] auto-start off (set AUTOSTART_BATCH=1 to enable); use the Run Morning Batch button`);
  }
});
