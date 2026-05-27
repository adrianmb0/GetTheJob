#!/usr/bin/env node
// GetTheJob — job application dashboard
// Zero npm deps. Built-ins only: node:http, node:fs, node:path, node:url.
// Works standalone or pointed at a career-ops data directory.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, renameSync, readdirSync, createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || 3737;
const ROOT = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(fileURLToPath(import.meta.url), '..');

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
:root {
  --bg: #fafafa;
  --fg: #1a1a1a;
  --muted: #6a6a6a;
  --border: #e3e3e3;
  --row-alt: #f5f5f5;
  --header-bg: #ffffff;
  --accent: #2563eb;
  --high: #16a34a;
  --apply: #2563eb;
  --skip: #9ca3af;
  --warn: #d97706;
  --score-high-bg: #dcfce7;
  --score-mid-bg: #dbeafe;
  --score-low-bg: #fef3c7;
  --score-skip-bg: #f3f4f6;
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
  background: var(--bg);
  color: var(--fg);
  margin: 0;
  padding: 0;
  line-height: 1.5;
}
.container {
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px 32px 64px;
}
.container:has(#triage-table) {
  max-width: 100%;
  padding: 24px 32px 64px;
  box-sizing: border-box;
}
header.top {
  background: #fff;
  border-bottom: 1px solid var(--border);
  padding: 12px 32px;
  position: sticky;
  top: 0;
  z-index: 10;
}
header.top nav a {
  margin-right: 16px;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
header.top nav a:hover { text-decoration: underline; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 18px; margin: 24px 0 8px; }
h3 { font-size: 16px; margin: 20px 0 6px; }
.muted { color: var(--muted); font-size: 13px; }
.filter-bar {
  margin: 12px 0 20px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.filter-bar a {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  text-decoration: none;
  font-size: 13px;
  color: var(--fg);
  background: #fff;
}
.filter-bar a.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13.5px;
}
#triage-table {
  table-layout: fixed;
}
#triage-table col.col-score    { width: 120px; }
#triage-table col.col-verdict  { width: 130px; }
#triage-table col.col-company  { width: 140px; }
#triage-table col.col-role     { width: 14%; }
#triage-table col.col-location { width: 130px; }
#triage-table col.col-pay      { width: 90px; }
#triage-table col.col-posted   { width: 100px; }
#triage-table col.col-url      { width: 120px; }
#triage-table col.col-note     { }
#triage-table col.col-actions  { width: 90px; }
#triage-table thead th { overflow: visible; }
#triage-table tbody td { overflow: hidden; text-overflow: ellipsis; }
#triage-table .url-cell a { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#triage-table .actions-cell {
  display: flex; flex-direction: column; gap: 4px;
  overflow: visible; white-space: normal;
}
#triage-table .actions-cell .btn-apply,
#triage-table .actions-cell .btn-shortlist,
#triage-table .actions-cell .btn-delete {
  margin-right: 0; width: 100%; text-align: center; box-sizing: border-box;
}
#triage-table .actions-cell .btn-delete { width: auto; align-self: center; }
thead th {
  position: sticky;
  top: 49px;
  background: var(--header-bg);
  border-bottom: 2px solid var(--border);
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  z-index: 5;
}
tbody td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
tbody tr:nth-child(even) { background: var(--row-alt); }
tbody tr:hover { background: #eff6ff; }
.md-table { font-size: 13.5px; }
.md-table th, .md-table td { padding: 8px 10px; border: 1px solid var(--border); }
.score-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 12.5px;
  white-space: nowrap;
}
.score-high { background: var(--score-high-bg); color: #166534; }
.score-mid  { background: var(--score-mid-bg);  color: #1e40af; }
.score-low  { background: var(--score-low-bg);  color: #92400e; }
.score-skip { background: var(--score-skip-bg); color: #4b5563; }
.verdict-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
}
.verdict-high  { background: #dcfce7; color: #166534; }
.verdict-apply { background: #dbeafe; color: #1e40af; }
.verdict-skip  { background: #f3f4f6; color: #4b5563; }
.verdict-warn  { background: #fef3c7; color: #92400e; }
.verdict-other { background: #ede9fe; color: #5b21b6; }
a { color: var(--accent); }
code {
  background: #f1f1f1;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
}
pre {
  background: #0f172a;
  color: #e2e8f0;
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 13px;
}
pre code { background: transparent; color: inherit; padding: 0; }
blockquote {
  border-left: 3px solid var(--border);
  padding: 4px 14px;
  color: var(--muted);
  margin: 12px 0;
}
hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
.report-body { background: #fff; padding: 28px 32px; border: 1px solid var(--border); border-radius: 6px; }
.empty { color: var(--muted); font-style: italic; padding: 24px; text-align: center; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { background: #f0f0f0; }
th .th-inner {
  display: flex; align-items: center; gap: 4px;
}
th .th-label { white-space: nowrap; }
th .th-controls { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; flex-shrink: 0; }
.col-sort {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--muted);
  padding: 2px 4px; border-radius: 4px; border: 1px solid transparent;
  min-width: 22px; min-height: 22px;
}
th.sortable:hover .col-sort { color: var(--fg); }
th.sort-asc .col-sort { color: var(--accent); }
th.sort-desc .col-sort { color: var(--accent); }
.btn-apply {
  background: var(--accent); color: #fff; border: 0;
  padding: 4px 10px; border-radius: 4px; font-size: 12.5px;
  cursor: pointer; font-weight: 500; font-family: inherit;
  margin-right: 6px;
}
.btn-apply:hover { opacity: 0.9; }
.btn-apply:disabled { background: var(--high); }
.btn-shortlist {
  background: #fef9c3; color: #713f12; border: 1px solid #fde047;
  padding: 4px 10px; border-radius: 4px; font-size: 12.5px;
  cursor: pointer; font-weight: 500; font-family: inherit;
  margin-right: 6px;
}
.btn-shortlist:hover { background: #fde047; }
.btn-shortlist:disabled { opacity: 0.7; cursor: default; }
.btn-add-toggle {
  padding: 4px 10px; border: 1px dashed var(--border);
  border-radius: 999px; text-decoration: none;
  font-size: 13px; color: var(--accent); background: #fff;
}
.btn-add-toggle:hover { border-color: var(--accent); }
.add-form {
  display: none;
  background: #fff; border: 1px solid var(--border);
  border-radius: 6px; padding: 14px 16px; margin: 0 0 20px;
}
.add-form.open { display: block; }
.add-form .add-row {
  display: flex; gap: 10px; margin-bottom: 8px;
  flex-wrap: wrap;
}
.add-form input[type=url], .add-form input[type=text] {
  padding: 6px 10px; border: 1px solid var(--border);
  border-radius: 4px; font-size: 13.5px;
  font-family: inherit;
}
.add-form input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.btn-report {
  display: inline-block;
  padding: 4px 10px; border-radius: 4px; font-size: 12.5px;
  border: 1px solid var(--border); background: #fff; color: var(--fg);
  text-decoration: none; font-weight: 500;
}
.btn-report:hover { background: var(--row-alt); }
.actions-cell { white-space: nowrap; }
.note-cell { font-size: 12.5px; color: #374151; line-height: 1.4; }
.toast {
  position: fixed; bottom: 24px; right: 24px;
  background: #1a1a1a; color: #fff; padding: 10px 16px;
  border-radius: 6px; font-size: 13px; opacity: 0;
  transition: opacity 0.2s; pointer-events: none;
  z-index: 100;
}
.toast.show { opacity: 1; }
.toast.error { background: #b91c1c; }
.col-filter {
  display: inline-flex; align-items: center; justify-content: center;
  position: relative; cursor: pointer;
  font-weight: 500; font-size: 13px;
  color: var(--muted); margin-left: 4px;
  padding: 2px 8px; border-radius: 4px;
  vertical-align: middle; border: 1px solid transparent;
  min-width: 24px; min-height: 22px;
}
.col-filter:hover { color: var(--accent); background: #e8f0fe; border-color: var(--accent); }
.col-filter.filtered { color: #fff; background: var(--accent); border-color: var(--accent); font-weight: 700; }
.col-dropdown {
  display: none; position: absolute; top: 100%; left: -8px;
  background: #fff; border: 1px solid var(--border);
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  padding: 6px 0; min-width: 160px; z-index: 50;
  max-height: 320px; overflow-y: auto;
}
.col-dropdown.open { display: block; }
.col-dropdown-loc { min-width: 180px; }
.col-dropdown label {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 12px; cursor: pointer; font-size: 12.5px;
  font-weight: 400; white-space: nowrap; color: var(--fg);
}
.col-dropdown label:hover { background: var(--row-alt); }
.col-dropdown label.opt-disabled { opacity: 0.35; }
.col-dropdown input[type=checkbox] {
  width: 14px; height: 14px; cursor: pointer; flex-shrink: 0;
}
.opt-count { color: var(--muted); font-size: 11px; margin-left: auto; }
.col-dropdown-clear {
  display: block; padding: 5px 12px; font-size: 12px;
  color: var(--accent); cursor: pointer; border-bottom: 1px solid var(--border);
  margin-bottom: 4px; text-align: left; background: none; border-top: none;
  border-left: none; border-right: none; width: 100%;
}
.col-dropdown-clear:hover { background: var(--row-alt); }
.url-cell a { font-size: 12px; word-break: break-all; }
.row-applied { opacity: 0.55; }
.row-applied .btn-apply { display: none; }
.row-rejected, .row-discarded { opacity: 0.45; }
.row-rejected .btn-apply, .row-discarded .btn-apply { display: none; }
.btn-mark {
  background: #fff; color: var(--high); border: 1px solid var(--high);
  padding: 4px 10px; border-radius: 4px; font-size: 12.5px;
  cursor: pointer; font-weight: 500; font-family: inherit;
}
.btn-mark:hover { background: var(--high); color: #fff; }
.btn-mark.done { background: var(--high); color: #fff; cursor: default; pointer-events: none; }
.status-select {
  font-family: inherit; font-size: 12.5px;
  padding: 3px 6px; border: 1px solid var(--border);
  border-radius: 4px; background: #fff; cursor: pointer;
  margin-right: 4px;
}
.status-select:hover { border-color: var(--accent); }
.status-select[data-status="Shortlisted"] { background: #fef9c3; color: #713f12; border-color: #fde047; }
.status-select[data-status="Applied"]   { background: #dcfce7; color: #166534; border-color: #86efac; }
.status-select[data-status="Responded"] { background: #dbeafe; color: #1e40af; border-color: #93c5fd; }
.status-select[data-status="Interview"] { background: #ede9fe; color: #5b21b6; border-color: #c4b5fd; }
.status-select[data-status="Offer"]     { background: #fef9c3; color: #713f12; border-color: #fde047; font-weight: 600; }
.status-select[data-status="Rejected"]  { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }
.status-select[data-status="Discarded"] { background: #f3f4f6; color: #4b5563; border-color: #d1d5db; }
.btn-delete {
  background: #fff; color: #b91c1c; border: 1px solid #fecaca;
  padding: 3px 7px; border-radius: 4px; font-size: 13px;
  cursor: pointer; font-family: inherit;
}
.btn-delete:hover { background: #fee2e2; border-color: #b91c1c; }
.row-deleting { opacity: 0; transition: opacity 0.2s; }
#panel-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.35);
  opacity: 0; pointer-events: none;
  transition: opacity 0.18s ease;
  z-index: 50;
}
#panel-overlay.show { opacity: 1; pointer-events: auto; }
#panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(880px, 92vw);
  background: #fff;
  box-shadow: -4px 0 24px rgba(0,0,0,0.16);
  transform: translateX(100%);
  transition: transform 0.22s ease;
  z-index: 60;
  display: flex; flex-direction: column;
}
#panel.show { transform: translateX(0); }
#panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 18px; border-bottom: 1px solid var(--border);
  background: #fafafa; flex-shrink: 0;
}
#panel-title { font-weight: 600; font-size: 14px; color: var(--muted); }
#panel-close {
  background: transparent; border: 0; font-size: 22px;
  cursor: pointer; color: var(--muted); line-height: 1; padding: 4px 8px;
  border-radius: 4px;
}
#panel-close:hover { background: var(--row-alt); color: var(--fg); }
#panel-body { padding: 24px 28px; overflow-y: auto; flex: 1; }
#panel-body .md-table { font-size: 13px; }
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
    const row = btn.closest('tr');
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
    const row = btn.closest('tr');
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
    const row = btn.closest('tr');
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
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('panel').classList.contains('show')) closePanel();
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
      openPanel(a.dataset.reportFile, a.dataset.reportTitle || a.textContent);
    });
  });
});
</script>
`;

function shell(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GetTheJob — ${escapeHtml(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💼</text></svg>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <nav>
    <a href="/">Tracker</a>
    <a href="/triage">Triage</a>
  </nav>
</header>
<main class="container">
${bodyHtml}
</main>
${PANEL_HTML}
${TABLE_JS}
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

// Spawn a new Terminal window, cd into the project, run `claude /career-ops apply <url>`.
function spawnTerminalApply(url) {
  if (!isSafeJobUrl(url)) throw new Error('Invalid URL');
  // ROOT is constructed from import.meta.url, so it doesn't contain hostile chars,
  // but escape single quotes defensively.
  const safeRoot = ROOT.replace(/'/g, `'\\''`);
  const inner = `cd '${safeRoot}' && claude '/career-ops apply ${url}'`;
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

Run \`/career-ops apply ${url}\` to generate the full A–G report and proceed with the application.

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
    return { status: 400, body: shell('Bad request', '<h1>Bad request</h1><p>Missing or invalid row number.</p><p><a href="/">← Back to tracker</a></p>') };
  }
  const packPath = findApplyPackForRow(num);
  if (!packPath) {
    return { status: 404, body: shell('No apply pack', `<h1>No apply pack for row #${escapeHtml(num)}</h1><p>Run <code>/career-ops apply &lt;url&gt;</code> in the terminal to generate one.</p><p><a href="/">← Back to tracker</a></p>`) };
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
<p><a href="/">← Back to tracker</a></p>
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
    background: #1a1a2e; color: #fff; border: 0; padding: 8px 14px;
    font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    border-radius: 4px 0 0 4px;
  }
  .doc-btn:hover:not(.disabled) { background: #2a2a4e; }
  .doc-btn.disabled { background: #ccc; color: #666; cursor: not-allowed; border-radius: 4px; }
  .doc-btn-secondary {
    background: #2a2a4e; color: #fff; padding: 8px 10px; font-size: 13px;
    text-decoration: none; border-radius: 0 4px 4px 0;
    display: inline-flex; align-items: center;
  }
  .doc-btn-secondary:hover { background: #3a3a6e; }
  .doc-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    z-index: 1000; padding: 24px;
  }
  .doc-overlay.open { display: flex; align-items: stretch; justify-content: center; }
  .doc-overlay-inner {
    background: #fff; width: 100%; max-width: 1100px;
    display: flex; flex-direction: column; border-radius: 6px; overflow: hidden;
    box-shadow: 0 12px 48px rgba(0,0,0,0.4);
  }
  .doc-overlay-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 16px; background: #1a1a2e; color: #fff;
  }
  .doc-overlay-head #doc-title { font-weight: 600; font-size: 14px; }
  .doc-overlay-actions { display: flex; gap: 12px; align-items: center; }
  .doc-overlay-actions a { color: #9be7ff; font-size: 12px; text-decoration: none; }
  .doc-overlay-actions a:hover { text-decoration: underline; }
  .doc-close {
    background: transparent; color: #fff; border: 0; font-size: 18px; cursor: pointer;
    line-height: 1; padding: 4px 8px;
  }
  .doc-close:hover { background: rgba(255,255,255,0.1); border-radius: 3px; }
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

function renderTracker(query) {
  const path = join(ROOT, 'data', 'applications.md');
  if (!existsSync(path)) {
    return shell('Tracker', '<h1>Tracker</h1><div class="empty">data/applications.md not found.</div>');
  }
  const text = readFileSync(path, 'utf8');
  const { header, rows } = parseApplicationsMd(text);
  // expected columns: #, Date, Company, Role, Score, Status, PDF, Report, Notes
  const idx = {
    num: header.findIndex(h => h.trim() === '#'),
    date: header.findIndex(h => /^date$/i.test(h)),
    company: header.findIndex(h => /^company$/i.test(h)),
    role: header.findIndex(h => /^role$/i.test(h)),
    score: header.findIndex(h => /^score$/i.test(h)),
    status: header.findIndex(h => /^status$/i.test(h)),
    pdf: header.findIndex(h => /^pdf$/i.test(h)),
    report: header.findIndex(h => /^report$/i.test(h)),
    notes: header.findIndex(h => /^notes$/i.test(h)),
  };

  // status filter
  const statusFilter = (query.status || '').trim();
  let filtered = rows;
  if (statusFilter) {
    filtered = rows.filter(r => (r[idx.status] || '').toLowerCase() === statusFilter.toLowerCase());
  }

  // low-score filter: hide rows scoring <3.0 (and N/A) by default; ?show_low=1 bypasses
  const showLow = query.show_low === '1';
  const isLowScore = (r) => {
    const raw = String(r[idx.score] || '');
    const m = raw.match(/([0-9]+(\.[0-9]+)?)/);
    if (!m) return true; // N/A → treat as low
    return parseFloat(m[1]) < 3.0;
  };
  const hiddenByLowScore = showLow ? 0 : filtered.filter(isLowScore).length;
  if (!showLow) filtered = filtered.filter(r => !isLowScore(r));

  // gather distinct statuses for filter chips
  const statuses = Array.from(new Set(rows.map(r => (r[idx.status] || '').trim()).filter(Boolean))).sort();

  const qs = (extra) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (showLow) params.set('show_low', '1');
    for (const [k, v] of Object.entries(extra || {})) {
      if (v == null) params.delete(k);
      else params.set(k, v);
    }
    const s = params.toString();
    return s ? '/?' + s : '/';
  };

  const chips = ['<a href="' + qs({status: null}) + '" class="' + (statusFilter ? '' : 'active') + '">All (' + rows.length + ')</a>']
    .concat(statuses.map(s => {
      const count = rows.filter(r => (r[idx.status] || '').toLowerCase() === s.toLowerCase()).length;
      const active = s.toLowerCase() === statusFilter.toLowerCase() ? 'active' : '';
      return `<a class="${active}" href="${qs({status: s})}">${escapeHtml(s)} (${count})</a>`;
    }))
    .concat([
      `<a class="${showLow ? 'active' : ''}" href="${qs({show_low: showLow ? null : '1'})}" title="Toggle visibility of rows scoring <3.0 or N/A">${showLow ? 'Hide low (<3.0)' : `Show low (<3.0) — ${hiddenByLowScore} hidden`}</a>`
    ])
    .join('');

  const reportLinkRe = /\[([^\]]+)\]\(([^)]+)\)/;
  const scanHistory = loadScanHistory();

  const tbodyRows = filtered.map(r => {
    const num = escapeHtml(r[idx.num] || '');
    const date = escapeHtml(r[idx.date] || '');
    const company = escapeHtml(r[idx.company] || '');
    const role = escapeHtml(r[idx.role] || '');
    const scoreRaw = r[idx.score] || '';
    const scoreNum = (String(scoreRaw).match(/([0-9]+(\.[0-9]+)?)/) || [])[1] || '0';
    const status = (r[idx.status] || '').trim();
    const isApplied = /^Applied$/i.test(status);
    let reportFile = '';
    let reportCell = '';
    const rRaw = r[idx.report] || '';
    const m = rRaw.match(reportLinkRe);
    if (m) {
      const target = m[2];
      if (/^reports\/[\w.\-]+\.md$/.test(target)) {
        reportFile = target;
        reportCell = `<a href="/report?file=${encodeURIComponent(target)}" data-report-file="${escapeHtml(target)}" data-report-title="${escapeHtml(company + ' — ' + role)}">${escapeHtml(m[1])}</a>`;
      } else {
        reportCell = escapeHtml(m[1]);
      }
    } else {
      reportCell = escapeHtml(rRaw);
    }

    const url = reportFile ? extractReportUrl(reportFile) : '';
    const urlCell = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url.length > 38 ? url.slice(0, 38) + '…' : url)}</a>`
      : '<span class="muted">—</span>';
    const datePosted = url ? (scanHistory.get(url) || '') : '';
    const datePostedCell = datePosted
      ? `<td data-sort-key="${escapeHtml(datePosted)}">${escapeHtml(datePosted)}</td>`
      : `<td data-sort-key=""><span class="muted">—</span></td>`;

    const applyBtn = url
      ? `<button class="btn-apply" onclick="applyJob('${escapeHtml(url)}', this)">Apply</button>`
      : '';
    const packPath = findApplyPackForRow(r[idx.num] || '');
    const packCell = packPath
      ? `<a class="pack-link" href="/apply?row=${encodeURIComponent(r[idx.num] || '')}" title="Open apply pack: form answers + tailored CV + cover letter">📎 View</a>`
      : '<span class="muted">—</span>';
    const currentStatus = CANONICAL_STATUSES.has(status) ? status : 'Evaluated';
    const statusOptions = ['Shortlisted','Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded']
      .map(s => `<option value="${s}"${s === currentStatus ? ' selected' : ''}>${s}</option>`).join('');
    const statusSelect = `<select class="status-select" data-num="${escapeHtml(num)}" data-status="${escapeHtml(currentStatus)}" onchange="setStatus(this)" title="Change status">${statusOptions}</select>`;
    const delBtn = `<button class="btn-delete" onclick="deleteRow('${escapeHtml(num)}', this)" title="Delete this row (invalid link / dead posting)">🗑</button>`;

    const rowClass = ['Applied','Rejected','Discarded'].includes(currentStatus)
      ? `row-${currentStatus.toLowerCase()}` : '';

    return `<tr class="${rowClass}">
      <td data-sort-key="${escapeHtml(num)}">${num}</td>
      <td data-sort-key="${escapeHtml(date)}">${date}</td>
      ${datePostedCell}
      <td data-sort-key="${escapeHtml(company)}"><strong>${company}</strong></td>
      <td>${role}</td>
      <td data-sort-key="${escapeHtml(scoreNum)}"><span class="score-pill ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw)}</span></td>
      <td data-cell="status">${escapeHtml(status)}</td>
      <td class="url-cell">${urlCell}</td>
      <td>${reportCell}</td>
      <td>${packCell}</td>
      <td class="actions-cell">${applyBtn}${statusSelect}${delBtn}</td>
    </tr>`;
  }).join('');

  const body = `
<h1>Applications Tracker</h1>
<div class="muted">${filtered.length} of ${rows.length} entries${statusFilter ? ` — filtered by status: <code>${escapeHtml(statusFilter)}</code>` : ''} · click <strong>Score</strong>, <strong>Company</strong>, <strong>Date</strong> headers to sort · click a chip below to filter (e.g. <strong>Evaluated</strong> = still to apply)</div>
<div class="filter-bar">${chips}<a href="#" class="btn-add-toggle" onclick="document.getElementById('add-form').classList.toggle('open');event.preventDefault();">+ Add posting</a></div>
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
    <button type="submit" class="btn-shortlist">Add to tracker</button>
  </div>
  <div class="muted" style="font-size:12px;margin-top:6px">Status will be set to <strong>Shortlisted</strong>. No evaluation runs — click <strong>Apply</strong> on the row later to trigger the full A–G report.</div>
</form>
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
    if (j.ok && j.noChange) { showToast('Already in tracker'); btn.disabled = false; btn.textContent = 'Add to tracker'; }
    else if (j.ok) { showToast('Added #' + j.num); setTimeout(() => location.reload(), 600); }
    else { btn.disabled = false; btn.textContent = 'Add to tracker'; showToast('Add failed: ' + (j.error || 'unknown'), true); }
  }).catch(err => { btn.disabled = false; btn.textContent = 'Add to tracker'; showToast(err.message, true); });
  return false;
}
</script>
<table>
  <thead>
    <tr>
      <th>#</th>
      <th class="sortable" data-sort="date" title="When the row was added to the tracker">Date Added</th>
      <th class="sortable" data-sort="date" title="When our scanner first saw the URL on the company's job board (proxy for actual posting date — typically within 0–3 days)">Date Posted</th>
      <th class="sortable" data-sort="str">Company</th>
      <th>Role</th>
      <th class="sortable sort-desc" data-sort="num">Score</th>
      <th>Status</th>
      <th>URL</th>
      <th>Report</th>
      <th title="Apply Pack: form answers + tailored CV + cover letter">Pack</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>
    ${tbodyRows || '<tr><td colspan="11" class="empty">No entries match this filter.</td></tr>'}
  </tbody>
</table>
`;
  return shell('Tracker', body);
}

function renderReport(query) {
  const file = query.file || '';
  // path-traversal guard
  if (!/^reports\/[\w.\-]+\.md$/.test(file)) {
    return { status: 400, body: shell('Bad request', '<h1>Bad request</h1><p>Invalid report path.</p><p><a href="/">← Back to tracker</a></p>') };
  }
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    return { status: 404, body: shell('Not found', '<h1>Not found</h1><p>Report does not exist.</p><p><a href="/">← Back to tracker</a></p>') };
  }
  const md = readFileSync(abs, 'utf8');
  const html = renderMarkdown(md);
  const body = `
<p><a href="/">← Back to tracker</a></p>
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

function renderTriage() {
  const path = join(ROOT, 'data', 'triage-scores.tsv');
  if (!existsSync(path)) {
    return shell('Triage', '<h1>Triage</h1><div class="empty">data/triage-scores.tsv not found.</div>');
  }
  const text = readFileSync(path, 'utf8');
  const { header, rows } = parseTsv(text);
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

  const scanHistory = loadScanHistory();

  const sorted = rows.slice().sort((a, b) => {
    const sa = parseFloat(a[idx.score]); const sb = parseFloat(b[idx.score]);
    if (Number.isNaN(sa) && Number.isNaN(sb)) return 0;
    if (Number.isNaN(sa)) return 1;
    if (Number.isNaN(sb)) return -1;
    return sb - sa;
  });

  // Display column order (explicit, decoupled from TSV column order):
  //   Score | Verdict | Company | Role | Pay Range | Date Posted | Date Added | URL | Note | Actions
  const columns = [
    { label: 'Score',       sort: 'num',  cls: 'sortable sort-desc' },
    { label: 'Verdict',     sort: 'str',  cls: 'sortable' },
    { label: 'Company',     sort: 'str',  cls: 'sortable' },
    { label: 'Role',        sort: null,   cls: '' },
    { label: 'Location',    sort: 'str',  cls: 'sortable' },
    { label: 'Pay Range',   sort: 'num',  cls: 'sortable', title: 'USD range parsed from the triage note. "—" means the note did not include a parseable range. Sort uses the upper bound.' },
    { label: 'Date Posted', sort: 'date', cls: 'sortable', title: 'When our scanner first saw this URL on the company\'s job board (proxy for actual posting date — typically within 0–3 days)' },
    { label: 'Date Added',  sort: 'date', cls: 'sortable', title: 'When this URL was first triaged' },
    { label: 'URL',         sort: null,   cls: '' },
    { label: 'Note',        sort: null,   cls: '' },
    { label: 'Actions',     sort: null,   cls: '' },
  ];

  const tbodyRows = sorted.map(r => {
    const url = r[idx.url] || '';
    const scoreRaw = r[idx.score] || '';
    const scoreNum = (String(scoreRaw).match(/([0-9]+(\.[0-9]+)?)/) || [])[1] || '0';
    const verdict = r[idx.verdict] || '';
    const company = r[idx.company] || '';
    const role = r[idx.role] || '';
    const dateAdded = r[idx.added] || '';
    const datePosted = scanHistory.get(url) || '';
    const location = idx.location >= 0 ? (r[idx.location] || '') : '';
    const note = r[idx.note] || '';
    const comp = extractComp(note);

    const urlCell = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(url)}">${escapeHtml(url.replace(/^https?:\/\//, ''))}</a>`
      : '';
    const shortlistBtn = url
      ? `<button class="btn-shortlist" onclick='shortlistJob(${JSON.stringify({url, company, role, score: scoreRaw, note}).replace(/'/g, "&apos;")}, this)' title="Move to tracker as Shortlisted (no evaluation yet)">→ Tracker</button>`
      : '';
    const dismissBtn = url
      ? `<button class="btn-delete" onclick="dismissTriage('${escapeHtml(url)}', this)" title="Remove from triage (doesn't fit / already reviewed)">🗑</button>`
      : '';

    const sn = parseFloat(scoreNum) || 0;
    const scoreBucket = sn >= 4.5 ? '4.5+' : sn >= 4.0 ? '4.0-4.4' : sn >= 3.5 ? '3.5-3.9' : '<3.5';

    return `<tr data-verdict="${escapeHtml(verdict)}" data-location="${escapeHtml(location)}" data-company="${escapeHtml(company)}" data-score-bucket="${scoreBucket}">
      <td data-sort-key="${escapeHtml(scoreNum)}"><span class="score-pill ${scoreClass(scoreRaw)}">${escapeHtml(scoreRaw)}</span></td>
      <td data-sort-key="${escapeHtml(verdict)}"><span class="verdict-pill ${verdictClass(verdict)}">${escapeHtml(verdict)}</span></td>
      <td data-sort-key="${escapeHtml(company)}"><strong>${escapeHtml(company)}</strong></td>
      <td>${escapeHtml(role)}</td>
      <td data-sort-key="${escapeHtml(location)}">${location ? escapeHtml(location) : '<span class="muted">—</span>'}</td>
      <td data-sort-key="${comp.sortKey}">${comp.display ? escapeHtml(comp.display) : '<span class="muted">—</span>'}</td>
      <td data-sort-key="${escapeHtml(datePosted)}">${datePosted ? escapeHtml(datePosted) : '<span class="muted">—</span>'}</td>
      <td class="url-cell">${urlCell}</td>
      <td class="note-cell" title="${escapeHtml(note)}">${escapeHtml(note)}</td>
      <td class="actions-cell">${shortlistBtn}${dismissBtn}</td>
    </tr>`;
  }).join('');

  const thead = '<tr>' + columns.map(c => {
    const titleAttr = c.title ? ` title="${escapeHtml(c.title)}"` : '';
    if (c.cls) {
      return `<th class="${c.cls}" data-sort="${c.sort}"${titleAttr}>${escapeHtml(c.label)}</th>`;
    }
    return `<th${titleAttr}>${escapeHtml(c.label)}</th>`;
  }).join('') + '</tr>';

  // Collect unique filter values from the data
  const verdictOrder = ['APPLY HIGH', 'APPLY', 'APPLY (reach)', 'SKIP', 'SKIP_STALE', 'SUSPICIOUS'];
  const verdictSet = new Set();
  const locationSet = new Set();
  const companySet = new Set();
  sorted.forEach(r => {
    const v = r[idx.verdict] || '';
    if (v) verdictSet.add(v);
    const loc = idx.location >= 0 ? (r[idx.location] || '') : '';
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
<h1>Triage Scores</h1>
<div class="muted" id="triage-summary">${sorted.length} entries · click column headers to sort · use ▾ dropdowns to filter</div>
<table id="triage-table">
  <colgroup>
    <col class="col-score"><col class="col-verdict"><col class="col-company"><col class="col-role">
    <col class="col-location"><col class="col-pay"><col class="col-posted">
    <col class="col-url"><col class="col-note"><col class="col-actions">
  </colgroup>
  <thead><tr>
    <th class="sortable sort-desc" data-sort="num"><div class="th-inner"><span class="th-label">Score</span><span class="th-controls"><span class="col-filter" data-col="score-bucket">▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear all</button>${scoreOpts}</div></span><span class="col-sort">↓</span></span></div></th>
    <th class="sortable" data-sort="str"><div class="th-inner"><span class="th-label">Verdict</span><span class="th-controls"><span class="col-filter" data-col="verdict">▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear all</button>${verdictOpts}</div></span><span class="col-sort">⇅</span></span></div></th>
    <th class="sortable" data-sort="str"><div class="th-inner"><span class="th-label">Company</span><span class="th-controls"><span class="col-filter" data-col="company">▾<div class="col-dropdown"><button class="col-dropdown-clear">Clear all</button>${companyOpts}</div></span><span class="col-sort">⇅</span></span></div></th>
    <th><div class="th-inner"><span class="th-label">Role</span></div></th>
    <th class="sortable" data-sort="str"><div class="th-inner"><span class="th-label">Location</span><span class="th-controls"><span class="col-filter" data-col="location">▾<div class="col-dropdown col-dropdown-loc"><button class="col-dropdown-clear">Clear all</button>${locationOpts}</div></span><span class="col-sort">⇅</span></span></div></th>
    <th class="sortable" data-sort="num" title="USD range parsed from the triage note. Sort uses the upper bound."><div class="th-inner"><span class="th-label">Pay Range</span><span class="th-controls"><span class="col-sort">⇅</span></span></div></th>
    <th class="sortable" data-sort="date" title="When our scanner first saw this URL on the company's job board"><div class="th-inner"><span class="th-label">Posted</span><span class="th-controls"><span class="col-sort">⇅</span></span></div></th>
    <th>URL</th>
    <th>Note</th>
    <th>Actions</th>
  </tr></thead>
  <tbody>${tbodyRows || '<tr><td class="empty" colspan="' + columns.length + '">No entries.</td></tr>'}</tbody>
</table>
<script>
(function() {
  const STORAGE_KEY = 'getthejob-triage-filters';
  const filterKeys = ['verdict', 'score-bucket', 'company', 'location'];
  const filters = {};
  filterKeys.forEach(k => filters[k] = new Set());
  const total = ${sorted.length};
  const rows = Array.from(document.querySelectorAll('#triage-table tbody tr')).filter(r => !r.querySelector('.empty'));
  const summary = document.getElementById('triage-summary');

  // Map each row to its data attributes for fast filtering
  const rowData = rows.map(r => ({
    el: r,
    verdict: r.dataset.verdict || '',
    'score-bucket': r.dataset.scoreBucket || '',
    company: r.dataset.company || '',
    location: r.dataset.location || ''
  }));

  // Check if a row passes a specific set of filters (excluding one key)
  function rowPassesExcluding(rd, excludeKey) {
    for (const k of filterKeys) {
      if (k === excludeKey) continue;
      if (filters[k].size === 0) continue;
      if (!filters[k].has(rd[k])) return false;
    }
    return true;
  }

  function applyFilters() {
    let shown = 0;
    const anyActive = filterKeys.some(k => filters[k].size > 0);
    rowData.forEach(rd => {
      let pass = true;
      for (const k of filterKeys) {
        if (filters[k].size === 0) continue;
        if (!filters[k].has(rd[k])) { pass = false; break; }
      }
      rd.el.style.display = pass ? '' : 'none';
      if (pass) shown++;
    });
    summary.textContent = anyActive
      ? shown + ' of ' + total + ' entries shown (filtered)'
      : total + ' entries · click column headers to sort · use \\u25be dropdowns to filter';

    // Cascade: update counts and availability for each dropdown
    document.querySelectorAll('.col-filter').forEach(trigger => {
      const col = trigger.dataset.col;
      const dropdown = trigger.querySelector('.col-dropdown');
      // Count how many rows match each option value given the OTHER filters
      const counts = {};
      rowData.forEach(rd => {
        if (!rowPassesExcluding(rd, col)) return;
        const val = rd[col];
        counts[val] = (counts[val] || 0) + 1;
      });
      dropdown.querySelectorAll('label[data-opt-value]').forEach(label => {
        const val = label.dataset.optValue;
        const count = counts[val] || 0;
        const countEl = label.querySelector('.opt-count');
        if (countEl) countEl.textContent = count > 0 ? '(' + count + ')' : '';
        label.classList.toggle('opt-disabled', count === 0 && !filters[col].has(val));
      });
    });

    saveFilters();
  }

  // Persist to localStorage
  function saveFilters() {
    const obj = {};
    filterKeys.forEach(k => { if (filters[k].size > 0) obj[k] = Array.from(filters[k]); });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch {}
  }

  function loadFilters() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      filterKeys.forEach(k => {
        if (Array.isArray(obj[k])) obj[k].forEach(v => filters[k].add(v));
      });
    } catch {}
  }

  // Sync checkbox UI to filter state, pruning stale values
  function syncCheckboxes() {
    document.querySelectorAll('.col-filter').forEach(trigger => {
      const col = trigger.dataset.col;
      const validValues = new Set();
      trigger.querySelectorAll('input[type=checkbox]').forEach(cb => {
        validValues.add(cb.dataset.value);
      });
      for (const v of filters[col]) {
        if (!validValues.has(v)) filters[col].delete(v);
      }
      trigger.classList.toggle('filtered', filters[col].size > 0);
      trigger.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = filters[col].has(cb.dataset.value);
      });
    });
  }

  // Dropdown toggle + checkbox handling
  document.querySelectorAll('.col-filter').forEach(trigger => {
    const col = trigger.dataset.col;
    const dropdown = trigger.querySelector('.col-dropdown');

    trigger.addEventListener('click', e => {
      if (e.target.closest('.col-dropdown')) return;
      e.stopPropagation();
      document.querySelectorAll('.col-dropdown.open').forEach(d => {
        if (d !== dropdown) d.classList.remove('open');
      });
      dropdown.classList.toggle('open');
    });

    dropdown.addEventListener('click', e => e.stopPropagation());

    const clearBtn = dropdown.querySelector('.col-dropdown-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', e => {
        e.stopPropagation();
        filters[col].clear();
        dropdown.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
        trigger.classList.remove('filtered');
        applyFilters();
      });
    }

    dropdown.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', e => {
        e.stopPropagation();
        const val = cb.dataset.value;
        if (cb.checked) filters[col].add(val);
        else filters[col].delete(val);
        trigger.classList.toggle('filtered', filters[col].size > 0);
        applyFilters();
      });
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.col-dropdown.open').forEach(d => d.classList.remove('open'));
  });

  // Clicking the header label opens the filter dropdown (for columns that have one)
  document.querySelectorAll('th.sortable').forEach(th => {
    const trigger = th.querySelector('.col-filter');
    if (!trigger) return;
    th.querySelector('.th-label').style.cursor = 'pointer';
    th.querySelector('.th-label').addEventListener('click', e => {
      e.stopPropagation();
      trigger.click();
    });
  });

  // Restore filters on page load
  loadFilters();
  syncCheckboxes();
  applyFilters();
})();
</script>
`;
  return shell('Triage', body);
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

const server = createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    const query = parseQuery(url);

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderTracker(query));
      return;
    }
    if (pathname === '/report') {
      const r = renderReport(query);
      res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(r.body);
      return;
    }
    if (pathname === '/triage') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderTriage());
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
    res.end(shell('Not found', '<h1>404</h1><p>Not found.</p><p><a href="/">← Back to tracker</a></p>'));
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
});
