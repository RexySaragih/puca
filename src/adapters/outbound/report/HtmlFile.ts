import fs from "node:fs/promises";
import path from "node:path";
import type { ReportPort } from "../../../application/ports/outbound/ReportPort.js";
import type { Mutant, SessionResult } from "../../../domain/mutant.js";

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
  const payload = {
    exitCode: result.exitCode,
    message: result.message ?? null,
    statuses: result.statuses.map((mutant) => serializeMutant(mutant, cwd)),
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
  --ink: #14181c;
  --paper: #f3efe6;
  --panel: #ebe4d6;
  --line: #c9bead;
  --muted: #5c6570;
  --accent: #b45309;
  --accent-soft: #f6e7d4;
  --killed: #1f6b45;
  --survived: #9b1c1c;
  --timeout: #8a5a00;
  --nocov: #4b5563;
  --error: #7f1d1d;
  --focus: #0f766e;
  --mono: "IBM Plex Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
  --sans: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); font: 15px/1.45 var(--sans); }
button, select, input { font: inherit; }
a { color: var(--accent); }
.shell { min-height: 100vh; display: grid; grid-template-rows: auto auto 1fr; }
.mast {
  display: flex; flex-wrap: wrap; gap: 1rem 2rem; align-items: end;
  justify-content: space-between; padding: 1.25rem 1.5rem 1rem;
  border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #f8f4ec, var(--paper));
}
.brand { font-family: var(--display); font-size: 1.85rem; letter-spacing: 0.02em; margin: 0; }
.brand span { color: var(--accent); }
.sub { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.92rem; }
.stats { display: flex; flex-wrap: wrap; gap: 0.55rem; }
.pill {
  border: 1px solid var(--line); background: var(--panel); border-radius: 999px;
  padding: 0.28rem 0.7rem; font-size: 0.82rem; color: var(--muted);
}
.pill strong { color: var(--ink); font-weight: 600; }
.toolbar {
  display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: center;
  padding: 0.85rem 1.5rem; border-bottom: 1px solid var(--line); background: var(--panel);
}
.filters { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.filter {
  border: 1px solid var(--line); background: var(--paper); color: var(--ink);
  border-radius: 0.4rem; padding: 0.35rem 0.65rem; cursor: pointer;
}
.filter[aria-pressed="true"] {
  background: var(--ink); color: var(--paper); border-color: var(--ink);
}
.filter:focus-visible, .file-btn:focus-visible, .row:focus-visible {
  outline: 2px solid var(--focus); outline-offset: 2px;
}
.search {
  flex: 1 1 12rem; min-width: 10rem; max-width: 22rem;
  border: 1px solid var(--line); background: var(--paper); border-radius: 0.4rem;
  padding: 0.4rem 0.65rem;
}
.layout {
  display: grid; grid-template-columns: minmax(12rem, 18rem) 1fr;
  min-height: 0;
}
@media (max-width: 840px) {
  .layout { grid-template-columns: 1fr; }
  .files { border-right: 0; border-bottom: 1px solid var(--line); max-height: 12rem; }
}
.files {
  border-right: 1px solid var(--line); background: #efe8da; overflow: auto; padding: 0.75rem;
}
.files h2 { margin: 0 0 0.55rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.file-btn {
  display: block; width: 100%; text-align: left; border: 0; background: transparent;
  padding: 0.45rem 0.55rem; border-radius: 0.35rem; cursor: pointer; color: var(--ink);
  font-family: var(--mono); font-size: 0.78rem;
}
.file-btn[aria-current="true"], .file-btn:hover { background: var(--accent-soft); }
.main { overflow: auto; padding: 1rem 1.25rem 2rem; }
.empty { color: var(--muted); padding: 1.5rem 0.25rem; }
.row {
  border: 1px solid var(--line); background: #fffdf8; border-radius: 0.55rem;
  padding: 0.85rem 1rem; margin: 0 0 0.75rem; cursor: pointer;
}
.row-head { display: flex; flex-wrap: wrap; gap: 0.5rem 0.85rem; align-items: baseline; }
.status {
  font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 0.15rem 0.45rem; border-radius: 0.25rem; color: #fff;
}
.status-Killed { background: var(--killed); }
.status-Survived { background: var(--survived); }
.status-Timeout { background: var(--timeout); }
.status-NoCoverage { background: var(--nocov); }
.status-RuntimeError { background: var(--error); }
.meta { font-family: var(--mono); font-size: 0.78rem; color: var(--muted); }
.mutator { font-weight: 600; }
.diff {
  margin-top: 0.65rem; font-family: var(--mono); font-size: 0.82rem;
  border: 1px solid var(--line); border-radius: 0.35rem; overflow: hidden;
}
.diff .minus, .diff .plus { display: block; padding: 0.35rem 0.55rem; white-space: pre-wrap; }
.diff .minus { background: #f8e8e8; color: #7f1d1d; }
.diff .plus { background: #e7f3ec; color: #14532d; border-top: 1px solid var(--line); }
.hidden { display: none !important; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
</style>
</head>
<body>
<div class="shell">
  <header class="mast">
    <div>
      <h1 class="brand">Pú<span>ca</span> report</h1>
      <p class="sub">Offline mutation session · exit <span id="exitCode"></span></p>
    </div>
    <div class="stats" id="stats" aria-live="polite"></div>
  </header>
  <div class="toolbar" role="region" aria-label="Filters">
    <div class="filters" id="filters" role="group" aria-label="Status filters"></div>
    <label class="sr-only" for="search">Search mutants</label>
    <input class="search" id="search" type="search" placeholder="Filter by file, mutator, or id" autocomplete="off"/>
  </div>
  <div class="layout">
    <aside class="files" aria-label="Files">
      <h2>Files</h2>
      <div id="fileList"></div>
    </aside>
    <main class="main" id="main" tabindex="-1">
      <p class="empty" id="empty">No mutants match the current filters.</p>
      <div id="rows"></div>
    </main>
  </div>
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

  var STATUS_ORDER = ["Killed", "Survived", "Timeout", "NoCoverage", "RuntimeError"];

  function counts() {
    var c = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0, RuntimeError: 0 };
    for (var i = 0; i < statuses.length; i++) c[statuses[i].status] = (c[statuses[i].status] || 0) + 1;
    return c;
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

  function renderStats() {
    var c = counts();
    var html = "";
    html += '<span class="pill">Total <strong>' + statuses.length + "</strong></span>";
    for (var i = 0; i < STATUS_ORDER.length; i++) {
      var key = STATUS_ORDER[i];
      html += '<span class="pill">' + key + " <strong>" + (c[key] || 0) + "</strong></span>";
    }
    document.getElementById("stats").innerHTML = html;
    document.getElementById("exitCode").textContent = String(data.exitCode);
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
    var html = '<button type="button" class="file-btn" data-file="ALL" aria-current="' +
      (activeFile === "ALL" ? "true" : "false") + '">All files</button>';
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      html += '<button type="button" class="file-btn" data-file="' + escapeHtml(f) +
        '" aria-current="' + (activeFile === f ? "true" : "false") + '">' + escapeHtml(f) + "</button>";
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
    var hay = (m.file + " " + m.mutatorName + " " + m.id + " " + m.original + " " + m.replacement).toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function renderRows() {
    var host = document.getElementById("rows");
    var empty = document.getElementById("empty");
    var html = "";
    var shown = 0;
    for (var i = 0; i < statuses.length; i++) {
      var m = statuses[i];
      if (!matches(m)) continue;
      shown += 1;
      html += '<article class="row" tabindex="0" data-id="' + escapeHtml(m.id) + '">' +
        '<div class="row-head">' +
        '<span class="status status-' + m.status + '">' + m.status + "</span>" +
        '<span class="mutator">' + escapeHtml(m.mutatorName) + "</span>" +
        '<span class="meta">' + escapeHtml(m.file) + ":" + m.line + ":" + m.column + "</span>" +
        "</div>" +
        '<div class="diff"><span class="minus">- ' + escapeHtml(m.original) +
        '</span><span class="plus">+ ' + escapeHtml(m.replacement) + "</span></div>" +
        "</article>";
    }
    host.innerHTML = html;
    empty.classList.toggle("hidden", shown > 0);
  }

  document.getElementById("search").addEventListener("input", function (ev) {
    query = String(ev.target.value || "").trim().toLowerCase();
    renderRows();
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

function serializeMutant(mutant: Mutant, cwd: string): {
  id: string;
  status: string;
  file: string;
  line: number;
  column: number;
  mutatorName: string;
  original: string;
  replacement: string;
  killedBy?: string;
} {
  return {
    id: mutant.site.id,
    status: mutant.status,
    file: toRelPath(cwd, mutant.site.file),
    line: mutant.site.line,
    column: mutant.site.column,
    mutatorName: mutant.site.mutatorName,
    original: mutant.site.original,
    replacement: mutant.site.replacement,
    killedBy: mutant.killedBy,
  };
}

function toRelPath(cwd: string, file: string): string {
  return path.relative(cwd, file).replace(/\\/g, "/") || file;
}
