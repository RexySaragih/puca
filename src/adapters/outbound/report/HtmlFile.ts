import fs from "node:fs/promises";
import path from "node:path";
import type { ReportPort } from "../../../application/ports/outbound/ReportPort.js";
import type { Mutant, SessionResult } from "../../../domain/mutant.js";
import { formatMutationLineDiff } from "./formatMutationContext.js";
import { SourceTextCache } from "./sourceTextCache.js";

/**
 * Self-contained offline HTML mutation report (ADR-034).
 * Zero CDN assets; zero @stryker-mutator/* dependencies.
 */
export class HtmlFile implements ReportPort {
  constructor(private readonly cwd: string = process.cwd()) {}

  async writeTerminal(_result: SessionResult): Promise<void> {
    // Terminal owned by StdioReport.
  }

  async writeHtml(pathToWrite: string, result: SessionResult): Promise<void> {
    const resolved = path.resolve(this.cwd, pathToWrite);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const html = renderHtmlDocument(result, this.cwd);
    await fs.writeFile(resolved, html, "utf8");
  }
}

function renderHtmlDocument(result: SessionResult, cwd: string): string {
  const sources = new SourceTextCache();
  const payload = {
    exitCode: result.exitCode,
    message: result.message ?? null,
    statuses: result.statuses.map((mutant) =>
      serializeMutant(mutant, cwd, sources),
    ),
  };
  const embedded = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Púca mutation report</title>
<style>
:root {
  --ink: #0a0a0a;
  --paper: #ffffff;
  --panel: #f4f4f2;
  --line: #d8d8d4;
  --muted: #5a5a56;
  --accent: #ff4500;
  --accent-dim: #ffe8de;
  --killed: #0d6b3a;
  --survived: #c41e00;
  --timeout: #b35c00;
  --nocov: #4a4f57;
  --error: #8b0000;
  --focus: #ff4500;
  --mono: "SFMono-Regular", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace;
  --text-xs: 0.8125rem;
  --text-sm: 0.9375rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.375rem;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%;
  background: var(--paper); color: var(--ink); font: var(--text-base)/1.5 var(--mono);
  overflow: hidden;
}
button, select, input { font: inherit; }
.shell {
  height: 100dvh; max-height: 100dvh; min-height: 0;
  display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto;
}
.telemetry {
  display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center;
  justify-content: space-between; padding: 0.65rem 1.25rem;
  border-bottom: 2px solid var(--ink); background: var(--ink); color: #f0f0ee;
  font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.08em;
}
.telemetry strong { color: var(--accent); font-weight: 700; }
.telemetry .chip {
  border: 1px solid #444; padding: 0.2rem 0.5rem; background: #141414;
}
.telemetry .chip.exit-1 { border-color: var(--survived); color: #ffb4a8; }
.telemetry .chip.exit-0 { border-color: var(--killed); color: #9dffc4; }
.dashboard {
  display: grid; grid-template-columns: auto 1fr; gap: 1.25rem 2rem;
  padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, #fafafa, var(--paper));
}
@media (max-width: 720px) { .dashboard { grid-template-columns: 1fr; } }
.gauge-wrap { display: flex; align-items: center; gap: 1rem; }
.gauge {
  width: 5.5rem; height: 5.5rem; flex-shrink: 0;
}
.gauge-label { font-size: var(--text-sm); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.gauge-value { font-size: var(--text-xl); font-weight: 700; }
.gauge-sub { font-size: var(--text-sm); color: var(--muted); margin-top: 0.2rem; }
.mast-title {
  margin: 0; font-size: 1.625rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;
}
.mast-title span { color: var(--accent); }
.seg-bar {
  display: flex; gap: 2px; height: 1.4rem; margin-top: 0.65rem; border: 1px solid var(--line);
}
.seg-bar .seg { flex: 1 1 0; min-width: 4px; background: var(--panel); transition: background 0.2s; }
.seg-legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin-top: 0.55rem; font-size: var(--text-sm); color: var(--muted); }
.seg-legend i { display: inline-block; width: 0.55rem; height: 0.55rem; margin-right: 0.25rem; vertical-align: middle; }
.stats { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.75rem; }
.pill {
  border: 1px solid var(--line); background: var(--paper); padding: 0.25rem 0.55rem;
  font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
}
.pill strong { color: var(--ink); }
.pill-Killed strong { color: var(--killed); }
.pill-Survived strong { color: var(--survived); }
.toolbar {
  display: flex; flex-wrap: wrap; gap: 0.65rem 1rem; align-items: center;
  padding: 0.65rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 5;
}
.filters { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.filter {
  border: 1px solid var(--ink); background: var(--paper); color: var(--ink);
  padding: 0.35rem 0.6rem; cursor: pointer; text-transform: uppercase;
  font-size: var(--text-sm); letter-spacing: 0.06em;
}
.filter[aria-pressed="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
.filter[data-status="Survived"][aria-pressed="true"] { background: var(--survived); border-color: var(--survived); }
.filter:focus-visible, .file-btn:focus-visible, .row:focus-visible, .copy-btn:focus-visible {
  outline: 2px solid var(--focus); outline-offset: 2px;
}
.search {
  flex: 1 1 10rem; min-width: 8rem; max-width: 20rem;
  border: 1px solid var(--ink); background: var(--paper); padding: 0.4rem 0.55rem;
}
.sort { border: 1px solid var(--ink); background: var(--paper); padding: 0.35rem 0.5rem; }
.layout {
  display: grid; grid-template-columns: minmax(15rem, 22rem) 1fr;
  min-height: 0; overflow: hidden;
}
@media (max-width: 840px) {
  .layout { grid-template-columns: 1fr; }
  .files {
    position: static; max-height: 11rem;
    border-right: 0; border-bottom: 1px solid var(--line);
  }
}
@media (min-width: 841px) {
  .files {
    position: sticky; top: 0; align-self: start;
    max-height: 100%; min-height: 0;
  }
}
.files {
  border-right: 1px solid var(--line); background: #f8f8f6;
  overflow-x: hidden; overflow-y: auto;
  padding: 0.65rem 0.5rem;
}
.section-head {
  display: flex; align-items: center; gap: 0.45rem; margin: 0 0 0.5rem 0.35rem;
  position: sticky; top: 0; z-index: 2;
  padding: 0.35rem 0.35rem 0.5rem; margin-left: 0;
  background: #f8f8f6; border-bottom: 1px solid var(--line);
  font-size: var(--text-sm); font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
}
.section-head::before {
  content: ""; width: 3px; height: 0.9rem; background: var(--accent); flex-shrink: 0;
}
.file-btn {
  display: flex; width: 100%; text-align: left; justify-content: space-between; gap: 0.35rem;
  border: 1px solid transparent; background: transparent;
  padding: 0.4rem 0.45rem; cursor: pointer; color: var(--ink);
  font-size: var(--text-sm); word-break: break-all; line-height: 1.45;
}
.file-btn[aria-current="true"] { border-color: var(--accent); background: var(--accent-dim); }
.file-btn:hover { border-color: var(--line); background: #fff; }
.file-count { flex-shrink: 0; color: var(--muted); font-size: var(--text-xs); }
.main { overflow-x: hidden; overflow-y: auto; min-height: 0; padding: 0.85rem 1rem 2rem; }
.list-head {
  display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;
  gap: 0.5rem; margin-bottom: 0.65rem; padding-bottom: 0.45rem; border-bottom: 1px dashed var(--line);
  font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted);
}
.empty { color: var(--muted); padding: 1.5rem 0.25rem; }
.row {
  border: 1px solid var(--line); background: var(--paper); margin: 0 0 0.5rem;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.row:hover { border-color: #aaa; }
.row.is-selected { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.row.is-collapsed .row-body { display: none; }
.row-head {
  display: flex; flex-wrap: wrap; gap: 0.4rem 0.65rem; align-items: center;
  padding: 0.55rem 0.65rem; cursor: pointer; user-select: none;
}
.chevron {
  width: 0.55rem; height: 0.55rem; border-right: 2px solid var(--ink); border-bottom: 2px solid var(--ink);
  transform: rotate(45deg); transition: transform 0.15s; flex-shrink: 0; margin-right: 0.15rem;
}
.row.is-collapsed .chevron { transform: rotate(-45deg); }
.status {
  font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 0.2rem 0.5rem; color: #fff;
}
.status-Killed { background: var(--killed); }
.status-Survived { background: var(--survived); }
.status-Timeout { background: var(--timeout); }
.status-NoCoverage { background: var(--nocov); }
.status-RuntimeError { background: var(--error); }
.meta { font-size: var(--text-sm); color: var(--muted); }
.mutator { font-weight: 700; color: var(--ink); }
.row-actions { margin-left: auto; display: flex; gap: 0.25rem; }
.copy-btn {
  border: 1px solid var(--line); background: var(--panel); padding: 0.15rem 0.4rem;
  font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer;
}
.copy-btn.ok { border-color: var(--killed); color: var(--killed); }
.row-body { padding: 0 0.65rem 0.65rem; }
.diff {
  font-size: var(--text-sm); border: 1px solid var(--line); overflow: hidden;
}
.diff .minus, .diff .plus { display: block; padding: 0.5rem 0.65rem; white-space: pre-wrap; line-height: 1.5; }
.diff .minus { background: #fff0f0; color: #8b0000; border-left: 3px solid var(--survived); }
.diff .plus { background: #f0fff6; color: #0d5c33; border-left: 3px solid var(--killed); border-top: 1px solid var(--line); }
.token-line { margin-top: 0.45rem; font-size: var(--text-sm); color: var(--muted); }
.killed-by { margin-top: 0.3rem; font-size: var(--text-sm); color: var(--killed); }
.footer {
  border-top: 1px solid var(--line); padding: 0.55rem 1.25rem; font-size: var(--text-xs);
  text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); background: var(--panel);
}
.hidden { display: none !important; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
</style>
</head>
<body>
<div class="shell">
  <div class="telemetry" aria-label="Session telemetry">
    <span>Púca <strong>mutation</strong> · offline report</span>
    <span class="chip" id="sessionChip">mutants · —</span>
    <span class="chip" id="exitChip">exit · <span id="exitCode">—</span></span>
  </div>
  <section class="dashboard" aria-label="Summary">
    <div class="gauge-wrap">
      <svg class="gauge" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r="24" fill="none" stroke="#e8e8e4" stroke-width="4"/>
        <circle id="gaugeArc" cx="28" cy="28" r="24" fill="none" stroke="#ff4500" stroke-width="4"
          stroke-linecap="square" stroke-dasharray="0 150.8" transform="rotate(-90 28 28)"/>
      </svg>
      <div>
        <div class="gauge-label">Mutation score</div>
        <div class="gauge-value" id="mutationScore">—</div>
        <div class="gauge-sub" id="mutationScoreSub">killed / detected</div>
      </div>
    </div>
    <div>
      <h1 class="mast-title">Session <span>teardown</span></h1>
      <div class="seg-bar" id="segBar" aria-hidden="true"></div>
      <div class="seg-legend" id="segLegend"></div>
      <div class="stats" id="stats" aria-live="polite"></div>
    </div>
  </section>
  <div class="toolbar" role="region" aria-label="Filters">
    <div class="filters" id="filters" role="group" aria-label="Status filters"></div>
    <label class="sr-only" for="search">Search mutants</label>
    <input class="search" id="search" type="search" placeholder="File · mutator · id · token" autocomplete="off"/>
    <label class="sr-only" for="sort">Sort order</label>
    <select class="sort" id="sort" aria-label="Sort order">
      <option value="file">Sort: file</option>
      <option value="line">Sort: line</option>
      <option value="status">Sort: status</option>
    </select>
  </div>
  <div class="layout">
    <aside class="files" aria-label="Modules">
      <h2 class="section-head">Modules</h2>
      <div id="fileList"></div>
    </aside>
    <main class="main" id="main" tabindex="-1">
      <div class="list-head">
        <span>Mutant log</span>
        <span id="shownCount">—</span>
      </div>
      <p class="empty hidden" id="empty">No mutants match filters · try another module or status</p>
      <div id="rows"></div>
    </main>
  </div>
  <footer class="footer">Self-contained · no CDN · arrow keys navigate · enter toggles diff</footer>
</div>
<script id="puca-session" type="application/json">${embedded}</script>
<script>
(function () {
  var raw = document.getElementById("puca-session").textContent;
  var data = JSON.parse(raw);
  var statuses = data.statuses || [];
  var activeStatus = "ALL";
  var activeFile = "ALL";
  var query = "";
  var sortKey = "file";
  var collapsed = {};
  var selectedId = "";
  var focusIndex = -1;

  var STATUS_ORDER = ["Killed", "Survived", "Timeout", "NoCoverage", "RuntimeError"];
  var STATUS_RANK = { Killed: 0, Survived: 1, Timeout: 2, NoCoverage: 3, RuntimeError: 4 };
  var SEG_COLORS = {
    Killed: "#0d6b3a", Survived: "#c41e00", Timeout: "#b35c00",
    NoCoverage: "#4a4f57", RuntimeError: "#8b0000"
  };
  var CIRC = 2 * Math.PI * 24;

  function counts() {
    var c = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0, RuntimeError: 0 };
    for (var i = 0; i < statuses.length; i++) c[statuses[i].status] = (c[statuses[i].status] || 0) + 1;
    return c;
  }

  function fileCounts() {
    var map = {};
    for (var i = 0; i < statuses.length; i++) {
      var f = statuses[i].file;
      map[f] = (map[f] || 0) + 1;
    }
    return map;
  }

  function uniqueFiles() {
    var map = {};
    var out = [];
    for (var i = 0; i < statuses.length; i++) {
      var f = statuses[i].file;
      if (!map[f]) { map[f] = true; out.push(f); }
    }
    out.sort();
    return out;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mutationScorePct() {
    var c = counts();
    var denom = statuses.length - (c.NoCoverage || 0);
    if (denom <= 0) return null;
    return Math.round(((c.Killed || 0) / denom) * 1000) / 10;
  }

  function renderDashboard() {
    var c = counts();
    var total = statuses.length;
    var pct = mutationScorePct();
    document.getElementById("sessionChip").textContent = "mutants · " + total;
    document.getElementById("exitCode").textContent = String(data.exitCode);
    var exitChip = document.getElementById("exitChip");
    exitChip.className = "chip exit-" + (data.exitCode === 0 ? "0" : "1");
    var scoreEl = document.getElementById("mutationScore");
    var subEl = document.getElementById("mutationScoreSub");
    if (pct === null) {
      scoreEl.textContent = "N/A";
      subEl.textContent = "no covered mutants";
      document.getElementById("gaugeArc").setAttribute("stroke-dasharray", "0 " + CIRC);
    } else {
      scoreEl.textContent = pct + "%";
      subEl.textContent = (c.Killed || 0) + " killed · " + denomLabel(c) + " covered";
      var arc = (pct / 100) * CIRC;
      document.getElementById("gaugeArc").setAttribute("stroke-dasharray", arc + " " + (CIRC - arc));
    }
    var segHost = document.getElementById("segBar");
    var segHtml = "";
    var legendHtml = "";
    for (var si = 0; si < STATUS_ORDER.length; si++) {
      var key = STATUS_ORDER[si];
      var n = c[key] || 0;
      for (var j = 0; j < n; j++) {
        segHtml += '<span class="seg" style="background:' + SEG_COLORS[key] + '" title="' + key + '"></span>';
      }
      if (n > 0) {
        legendHtml += '<span><i style="background:' + SEG_COLORS[key] + '"></i>' + key + " " + n + "</span>";
      }
    }
    segHost.innerHTML = segHtml || '<span class="seg" style="flex:1;background:#e8e8e4"></span>';
    document.getElementById("segLegend").innerHTML = legendHtml;
  }

  function denomLabel(c) {
    return totalCovered(c);
  }

  function totalCovered(c) {
    return statuses.length - (c.NoCoverage || 0);
  }

  function renderStats() {
    var c = counts();
    var html = '<span class="pill">Total <strong>' + statuses.length + "</strong></span>";
    for (var i = 0; i < STATUS_ORDER.length; i++) {
      var key = STATUS_ORDER[i];
      html += '<span class="pill pill-' + key + '">' + key + " <strong>" + (c[key] || 0) + "</strong></span>";
    }
    document.getElementById("stats").innerHTML = html;
    renderDashboard();
  }

  function renderFilters() {
    var host = document.getElementById("filters");
    var keys = ["ALL"].concat(STATUS_ORDER);
    var html = "";
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var label = key === "ALL" ? "All" : key;
      html += '<button type="button" class="filter" data-status="' + key + '" aria-pressed="' +
        (activeStatus === key ? "true" : "false") + '">' + label + "</button>";
    }
    host.innerHTML = html;
    host.onclick = function (ev) {
      var btn = ev.target.closest("button.filter");
      if (!btn) return;
      activeStatus = btn.getAttribute("data-status");
      renderFilters();
      renderRows();
    };
  }

  function renderFiles() {
    var host = document.getElementById("fileList");
    var files = uniqueFiles();
    var fc = fileCounts();
    var allN = statuses.length;
    var html = '<button type="button" class="file-btn" data-file="ALL" aria-current="' +
      (activeFile === "ALL" ? "true" : "false") + '"><span>All modules</span><span class="file-count">' +
      allN + "</span></button>";
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      html += '<button type="button" class="file-btn" data-file="' + escapeHtml(f) +
        '" aria-current="' + (activeFile === f ? "true" : "false") + '"><span>' + escapeHtml(f) +
        '</span><span class="file-count">' + (fc[f] || 0) + "</span></button>";
    }
    host.innerHTML = html;
    host.onclick = function (ev) {
      var btn = ev.target.closest("button.file-btn");
      if (!btn) return;
      activeFile = btn.getAttribute("data-file");
      renderFiles();
      renderRows();
    };
  }

  function matches(m) {
    if (activeStatus !== "ALL" && m.status !== activeStatus) return false;
    if (activeFile !== "ALL" && m.file !== activeFile) return false;
    if (!query) return true;
    var hay = (m.file + " " + m.mutatorName + " " + m.id + " " + m.original + " " +
      m.replacement + " " + m.before + " " + m.after).toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function sortedFiltered() {
    var list = [];
    for (var i = 0; i < statuses.length; i++) {
      if (matches(statuses[i])) list.push(statuses[i]);
    }
    list.sort(function (a, b) {
      if (sortKey === "status") {
        var ra = STATUS_RANK[a.status] !== undefined ? STATUS_RANK[a.status] : 9;
        var rb = STATUS_RANK[b.status] !== undefined ? STATUS_RANK[b.status] : 9;
        if (ra !== rb) return ra - rb;
      }
      if (sortKey === "line" || sortKey === "file") {
        if (a.file !== b.file) return a.file < b.file ? -1 : 1;
        if (a.line !== b.line) return a.line - b.line;
        return a.column - b.column;
      }
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });
    return list;
  }

  function isCollapsed(id) {
    return collapsed[id] === true;
  }

  function toggleRow(id) {
    collapsed[id] = !isCollapsed(id);
    var row = document.querySelector('.row[data-id="' + id.replace(/"/g, "") + '"]');
    if (row) row.classList.toggle("is-collapsed", isCollapsed(id));
  }

  function copyLocation(m, btn) {
    var loc = m.file + ":" + m.line + ":" + m.column;
    function done() {
      btn.classList.add("ok");
      btn.textContent = "copied";
      setTimeout(function () { btn.classList.remove("ok"); btn.textContent = "loc"; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(loc).then(done).catch(function () {
        window.prompt("Copy location", loc);
      });
    } else {
      window.prompt("Copy location", loc);
    }
  }

  function bindRowEvents() {
    var host = document.getElementById("rows");
    host.onclick = function (ev) {
      var copyBtn = ev.target.closest("button.copy-btn");
      if (copyBtn) {
        ev.stopPropagation();
        var id = copyBtn.getAttribute("data-copy-id");
        for (var i = 0; i < statuses.length; i++) {
          if (statuses[i].id === id) { copyLocation(statuses[i], copyBtn); break; }
        }
        return;
      }
      var head = ev.target.closest(".row-head");
      if (!head) return;
      var row = head.closest(".row");
      if (!row) return;
      var id = row.getAttribute("data-id");
      selectedId = id;
      document.querySelectorAll(".row.is-selected").forEach(function (r) { r.classList.remove("is-selected"); });
      row.classList.add("is-selected");
      toggleRow(id);
    };
  }

  function renderRows() {
    var host = document.getElementById("rows");
    var empty = document.getElementById("empty");
    var list = sortedFiltered();
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var col = isCollapsed(m.id);
      var killedLine = m.killedBy
        ? '<div class="killed-by">killed by · ' + escapeHtml(m.killedBy) + "</div>"
        : "";
      html += '<article class="row' + (col ? " is-collapsed" : "") +
        (selectedId === m.id ? " is-selected" : "") + '" tabindex="0" data-id="' + escapeHtml(m.id) +
        '" data-index="' + i + '">' +
        '<div class="row-head"><span class="chevron" aria-hidden="true"></span>' +
        '<span class="status status-' + m.status + '">' + m.status + "</span>" +
        '<span class="mutator">' + escapeHtml(m.mutatorName) + "</span>" +
        '<span class="meta">' + escapeHtml(m.file) + ":" + m.line + ":" + m.column + "</span>" +
        '<span class="row-actions"><button type="button" class="copy-btn" data-copy-id="' +
        escapeHtml(m.id) + '">loc</button></span></div>' +
        '<div class="row-body">' +
        '<div class="diff"><span class="minus">- ' + escapeHtml(m.before) +
        '</span><span class="plus">+ ' + escapeHtml(m.after) + "</span></div>" +
        '<div class="token-line">token · ' + escapeHtml(m.original) + " → " +
        escapeHtml(m.replacement) + "</div>" + killedLine + "</div></article>";
    }
    host.innerHTML = html;
    empty.classList.toggle("hidden", list.length > 0);
    document.getElementById("shownCount").textContent = list.length + " / " + statuses.length + " shown";
    bindRowEvents();
    focusIndex = -1;
  }

  document.getElementById("search").addEventListener("input", function (ev) {
    query = String(ev.target.value || "").trim().toLowerCase();
    renderRows();
  });

  document.getElementById("sort").addEventListener("change", function (ev) {
    sortKey = String(ev.target.value || "file");
    renderRows();
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT")) return;
    var rows = document.querySelectorAll("#rows .row");
    if (!rows.length) return;
    if (ev.key === "j" || ev.key === "ArrowDown") {
      ev.preventDefault();
      focusIndex = Math.min(focusIndex + 1, rows.length - 1);
      rows[focusIndex].focus();
      rows[focusIndex].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "k" || ev.key === "ArrowUp") {
      ev.preventDefault();
      focusIndex = Math.max(focusIndex - 1, 0);
      rows[focusIndex].focus();
      rows[focusIndex].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" && document.activeElement && document.activeElement.classList.contains("row")) {
      var id = document.activeElement.getAttribute("data-id");
      if (id) toggleRow(id);
    }
  });

  renderStats();
  renderFilters();
  renderFiles();
  renderRows();
})();
</script>
</body>
</html>
`;
}

function serializeMutant(
  mutant: Mutant,
  cwd: string,
  sources: SourceTextCache,
): {
  id: string;
  status: string;
  file: string;
  line: number;
  column: number;
  mutatorName: string;
  original: string;
  replacement: string;
  before: string;
  after: string;
  killedBy?: string;
} {
  const diff = formatMutationLineDiff(
    sources.get(mutant.site.file),
    mutant.site,
  );
  return {
    id: mutant.site.id,
    status: mutant.status,
    file: toRelPath(cwd, mutant.site.file),
    line: mutant.site.line,
    column: mutant.site.column,
    mutatorName: mutant.site.mutatorName,
    original: mutant.site.original,
    replacement: mutant.site.replacement,
    before: diff.before,
    after: diff.after,
    killedBy: mutant.killedBy,
  };
}

function toRelPath(cwd: string, file: string): string {
  return path.relative(cwd, file).replace(/\\/g, "/") || file;
}
