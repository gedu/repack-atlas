// The Studio page: ONE self-contained HTML string (docs/PRD.md §7.2).
//
// Hard rules this file exists to satisfy (AGENTS.md rule 5):
//   - Offline: no CDN, no webfonts, no external `src`/`href` of any kind. The
//     only URL in the whole document is the SVG namespace passed to
//     `createElementNS`, which is an identifier, not a fetch.
//   - Manifest content is UNTRUSTED input. Every string that comes from the
//     server reaches the DOM through `textContent` / `createTextNode` /
//     SVG text nodes. Markup is never parsed from a string, so a manifest
//     containing
//     `<script>` renders as those literal characters (tests/e2e/studio.spec.ts
//     proves it with fixtures/fixture-xss).
//   - Read-only forever: there is no form, no POST, no mutation of anything.
//     The one write-ish affordance is a "copy snippet" button, which hands the
//     human a line to paste and commit themselves (PRD §7.3).
//
// Visual language: ported from the Re.Pack Federation Studio mock
// (odd/reports/federation-studio-mock.html in the repack fork) — same brand
// tokens, panel layout, 168x78 rounded nodes, cubic edges with arrowheads and
// module labels, dashed-red cycle edges, severity stripes in the findings
// list. Dropped on purpose: the Google-Fonts `link` tags (offline rule) and
// every string-to-markup template in it (security rule).

/**
 * The whole page. Deliberately a compile-time constant with zero
 * interpolation: the only data that reaches the browser arrives over
 * `/api/graph` and `/api/events`, where the client-side rules above apply.
 */
export const STUDIO_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Federation Studio</title>
<style>
  :root {
    --ground: #f9f8fd;
    --surface: #ffffff;
    --surface-2: #f4f2fa;
    --ink: #201f24;
    --ink-2: #5c5b63;
    --ink-3: #838289;
    --line: #e9e7ee;
    --line-strong: #cfced5;
    --accent: #8232ff;
    --accent-ink: #6a1fe6;
    --accent-soft: #8232ff1f;
    --teal: #1fb8a2;
    --ok: #1f8a10;
    --ok-soft: #2fc71729;
    --warn: #a86200;
    --warn-fill: #ffb14c;
    --warn-soft: #ffb14c33;
    --bad: #d63c3c;
    --bad-fill: #fa7171;
    --bad-soft: #fa717129;
    --grid: #e9e7ee;
    --sans: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --ground: #18171b;
      --surface: #201f24;
      --surface-2: #2b2a2f;
      --ink: #ffffff;
      --ink-2: #cfced5;
      --ink-3: #9a99a1;
      --line: #424145;
      --line-strong: #636266;
      --accent: #9b6dff;
      --accent-ink: #b594ff;
      --accent-soft: #8232ff33;
      --teal: #3ce4cb;
      --ok: #5fd94a;
      --warn: #ffb14c;
      --bad: #fa7171;
      --bad-fill: #fa7171;
      --grid: #2b2a2f;
    }
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--ground); color: var(--ink);
    font-family: var(--sans); font-size: 14px; line-height: 1.5;
    padding: 16px 16px 32px; overflow-x: hidden;
  }
  .wrap { max-width: 1240px; margin: 0 auto; display: grid; gap: 14px; }

  /* Top bar: brand, workspace URL, one pill per app. */
  .bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: 10px; padding: 10px 14px;
  }
  .brand { display: flex; align-items: baseline; gap: 10px; }
  .brand h1 {
    font-size: 17px; font-weight: 700; margin: 0; letter-spacing: -0.01em;
    background: linear-gradient(90deg, #9b6dff 20%, #3ce4cb 95%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .brand .by { font-size: 12px; color: var(--ink-3); }
  .url { font-family: var(--mono); font-size: 12px; color: var(--ink-3); overflow-wrap: anywhere; }
  .sessions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
  .sess {
    font: inherit; font-family: var(--mono); font-size: 12px; color: var(--ink-2);
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 8px; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
  .dot-ready { background: var(--teal); }
  .dot-starting, .dot-bundling { background: var(--warn-fill); }
  .dot-error { background: var(--bad-fill); }
  .dot-idle, .dot-stopped { background: var(--ink-3); }
  .live {
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--ink-3); background: var(--surface-2);
    padding: 2px 8px; border-radius: 4px;
  }
  .live.err { color: var(--bad); background: var(--bad-soft); }

  /* Top-level views: Apps (graph + inspector + per-app findings) vs the
     workspace-wide Doctor table. Distinct from the inspector's .tabs. */
  .view-tabs {
    display: flex; gap: 4px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 10px; padding: 0 8px;
  }
  .view-tab {
    font: inherit; font-size: 13px; font-weight: 600; color: var(--ink-2);
    background: none; border: 0; border-bottom: 2px solid transparent;
    padding: 9px 12px; cursor: pointer; margin-bottom: -1px;
  }
  .view-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
  .view-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .view { display: grid; gap: 14px; }
  .view[hidden] { display: none; }

  /* Graph (1.55fr) + inspector (1fr), full-width findings below.
     The row height is driven by the graph panel ALONE: 'align-items' stays at
     its default 'stretch' and the inspector is size-contained (below), so a
     long Shared table can never grow the row and push the findings panel down. */
  .main { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 14px; }
  @media (max-width: 900px) { .main { grid-template-columns: minmax(0, 1fr); } }

  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; min-width: 0; }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--line);
  }
  .panel-head h2 { font-size: 12px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-2); margin: 0; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--ink-3); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { display: inline-block; width: 18px; height: 0; border-top: 2px solid var(--ink-3); }
  .legend i.cyc { border-top: 2px dashed var(--bad-fill); }

  /* No horizontal scroll: the SVG scales with its box (viewBox), never overflows it. */
  .graph-box { overflow: hidden; }
  svg.graph { display: block; width: 100%; height: auto; }
  .edge { fill: none; stroke: var(--ink-3); stroke-width: 1.6; }
  .edge.cycle { stroke: var(--bad-fill); stroke-dasharray: 6 4; }
  .edge.hi { stroke: var(--accent); stroke-width: 2.4; }
  .edge.cycle.hi { stroke: var(--bad); }
  .elabel { font-family: var(--mono); font-size: 11px; fill: var(--ink-2); }
  .elabel-bg { fill: var(--surface); }
  .elabel.cycle { fill: var(--bad); }
  .node { cursor: pointer; }
  .node rect.box { fill: var(--surface); stroke: var(--line-strong); stroke-width: 1.2; }
  .node.sel rect.box { stroke: var(--accent); stroke-width: 2.2; fill: var(--accent-soft); }
  .node:focus { outline: none; }
  .node:focus-visible rect.box { stroke: var(--accent); stroke-width: 2.6; }
  .node .name { font-size: 14px; font-weight: 600; fill: var(--ink); }
  .node .meta { font-family: var(--mono); font-size: 11px; fill: var(--ink-3); }
  .node .role { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; fill: var(--accent-ink); }
  .badge-c { fill: var(--bad-fill); }
  .badge-w { fill: var(--warn-fill); }
  .tag-standalone { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1; }
  .tag-standalone-t { font-size: 10px; font-weight: 600; fill: var(--accent-ink); }
  .badge-t { font-size: 11px; font-weight: 700; fill: #201f24; }
  .grid-dot { fill: var(--grid); }
  @media (prefers-reduced-motion: no-preference) {
    .edge { transition: stroke 0.15s, stroke-width 0.15s; }
  }

  /* Inspector */
  .tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .tab {
    font: inherit; font-size: 13px; color: var(--ink-2); background: none; border: 0;
    padding: 8px 10px; border-bottom: 2px solid transparent; cursor: pointer; margin-bottom: -1px;
  }
  .tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 500; }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .insp-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .insp-title strong { font-size: 16px; }
  /* The inspector is exactly as tall as the graph panel and scrolls inside its
     own card. 'contain: size' makes its intrinsic contribution to the grid row
     zero, so the row is the graph's height and the default 'stretch' hands that
     height back to this card; the tab body is the scroller. A browser without
     containment falls back to the old behaviour (row grows, nothing clips), so
     the height cap is the only thing that degrades, never the content. */
  .panel-inspector { display: flex; flex-direction: column; contain: size; }
  .panel-inspector > .panel-head,
  .panel-inspector > .tabs { flex: none; }
  .panel-inspector > .tab-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
  /* Single column (stacked): every panel owns a row and hugs its own content,
     so there is no row height to match and size containment would collapse the
     card to its header. Declared after the base rule so it wins. */
  @media (max-width: 900px) {
    .panel-inspector { contain: none; }
    .panel-inspector > .tab-body { overflow: visible; }
  }
  .tab-body { padding: 12px 14px 14px; display: grid; gap: 10px; }
  .hint { font-size: 12.5px; color: var(--ink-3); margin: 0; }

  .files { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-family: var(--mono); font-size: 12.5px; }
  .files li { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 10px; padding: 6px; border-radius: 6px; }
  .files li:hover { background: var(--surface-2); }
  .files .path { color: var(--ink-2); overflow-wrap: anywhere; }
  .files .path b { color: var(--ink); font-weight: 500; }
  .exp-name { color: var(--accent-ink); font-size: 11.5px; white-space: nowrap; }
  .used-by { grid-column: 1 / -1; font-size: 11.5px; color: var(--ink-3); }
  .used-by.warn { color: var(--warn); }
  .sec-title { font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); margin-top: 4px; }
  .snippet { grid-column: 1 / -1; margin: 4px 0 0; padding: 8px 10px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--line); font-family: var(--mono); font-size: 12px; overflow-x: auto; white-space: pre; color: var(--ink); }
  button.btn {
    font: inherit; font-size: 12px; font-weight: 500; border-radius: 6px; padding: 3px 10px; cursor: pointer;
    border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink);
  }
  button.btn:hover { border-color: var(--accent); color: var(--accent-ink); }
  button.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .scroll-x { overflow-x: auto; }
  table.kv { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.kv th { text-align: left; font-weight: 500; color: var(--ink-3); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 6px; border-bottom: 1px solid var(--line); }
  table.kv td { padding: 6px; border-bottom: 1px solid var(--line); font-family: var(--mono); font-variant-numeric: tabular-nums; vertical-align: top; overflow-wrap: anywhere; }
  table.kv td.has-pill { white-space: nowrap; min-width: 88px; overflow-wrap: normal; }
  table.kv td.nowrap { white-space: nowrap; overflow-wrap: normal; }
  table.kv td.st { font-family: var(--sans); white-space: normal; }
  .pill { display: inline-block; white-space: nowrap; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; }
  .pill.ok { color: var(--ok); background: var(--ok-soft); }
  .pill.warn { color: var(--warn); background: var(--warn-soft); }
  .pill.bad { color: var(--bad); background: var(--bad-soft); }

  /* Compare view: the shared-dependency matrix (issue #73). The package
     column sticks so the row label survives the horizontal scroll. */
  .pill.ref { color: var(--accent-ink); background: var(--accent-soft); }
  .pill.mute { color: var(--ink-3); background: var(--surface-2); }
  table.kv td.pkg, table.kv th.pkg { position: sticky; left: 0; background: var(--surface); }
  table.kv td.verdict { white-space: nowrap; overflow-wrap: normal; }

  /* Doctor findings: severity filter chips (same pill language as .sess). */
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    font: inherit; font-family: var(--mono); font-size: 12px; color: var(--ink-2);
    cursor: pointer; padding: 2px 9px; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
  }
  .chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent-ink); background: var(--accent-soft); }
  .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Doctor findings with severity stripes. */
  .issues { list-style: none; margin: 0; padding: 6px; display: grid; gap: 4px; }
  .issue {
    display: grid; grid-template-columns: 4px auto 1fr auto; gap: 10px; align-items: center;
    padding: 8px 10px 8px 0; border-radius: 6px; cursor: pointer; background: none;
    border: 0; width: 100%; font: inherit; color: inherit; text-align: left;
  }
  .issue:hover { background: var(--surface-2); }
  .issue:focus-visible { outline: 2px solid var(--accent); }
  .stripe { align-self: stretch; border-radius: 2px; background: var(--warn-fill); }
  .stripe.bad { background: var(--bad-fill); }
  .stripe.info { background: var(--line-strong); }
  .code { font-family: var(--mono); font-size: 11.5px; font-weight: 500; color: var(--ink-2); white-space: nowrap; }
  .issue .msg { font-size: 13px; overflow-wrap: anywhere; }
  .issue .where { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); white-space: nowrap; }
  .issue-more {
    font: inherit; font-family: var(--mono); font-size: 11.5px; color: var(--ink-3);
    background: none; border: 1px dashed var(--line-strong); border-radius: 6px;
    padding: 3px 10px; margin: 2px 0 0 14px; cursor: pointer;
  }
  .issue-more:hover { border-color: var(--accent); color: var(--accent-ink); }
  .issue-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 560px) {
    .issue { grid-template-columns: 4px 1fr; }
    .issue .code, .issue .msg, .issue .where { grid-column: 2; }
  }

  .toast {
    position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%); background: var(--ink); color: var(--surface);
    font-size: 13px; padding: 8px 14px; border-radius: 8px;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.18); max-width: calc(100% - 32px);
  }
  .toast[hidden] { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header class="bar">
    <div class="brand">
      <h1>Federation Studio</h1><span class="by">Repack Atlas</span>
      <span class="url" id="workspace-url"></span>
    </div>
    <span class="live" id="live" data-state="connecting">connecting</span>
    <div class="sessions" id="sessions"></div>
  </header>

  <nav class="view-tabs" id="view-tabs" role="tablist" aria-label="Studio views">
    <button class="view-tab" role="tab" type="button" id="view-tab-apps" data-view="apps"
            aria-selected="true" aria-controls="view-apps">Apps</button>
    <button class="view-tab" role="tab" type="button" id="view-tab-compare" data-view="compare"
            aria-selected="false" aria-controls="view-compare">Compare</button>
    <button class="view-tab" role="tab" type="button" id="view-tab-doctor" data-view="doctor"
            aria-selected="false" aria-controls="view-doctor">Doctor</button>
  </nav>

  <section class="view" id="view-apps" role="tabpanel" aria-labelledby="view-tab-apps">
  <div class="main">
    <section class="panel" aria-label="Federation graph">
      <div class="panel-head">
        <h2>Graph</h2>
        <div class="legend">
          <span><i></i>consumes</span>
          <span><i class="cyc"></i>circular dependency</span>
        </div>
      </div>
      <div class="graph-box">
        <svg class="graph" id="graph" role="img" aria-label="Federation apps and the modules each one consumes"></svg>
      </div>
    </section>

    <section class="panel panel-inspector" aria-label="Inspector">
      <div class="panel-head">
        <div class="insp-title"><strong id="insp-name"></strong><span class="url" id="insp-meta"></span></div>
      </div>
      <div class="tabs" role="tablist" id="tabs">
        <button class="tab" role="tab" data-tab="exposes" aria-selected="true">Exposes</button>
        <button class="tab" role="tab" data-tab="shared" aria-selected="false">Shared</button>
        <button class="tab" role="tab" data-tab="native" aria-selected="false">Native</button>
        <button class="tab" role="tab" data-tab="bundle" aria-selected="false">Bundle</button>
      </div>
      <div class="tab-body" id="tab-body"></div>
    </section>
  </div>

    <section class="panel" id="app-findings" aria-label="Findings for the selected app">
      <div class="panel-head">
        <h2 id="app-findings-title">Findings</h2>
      </div>
      <ul class="issues" id="app-issues"></ul>
    </section>
  </section>

  <section class="panel view" id="view-compare" role="tabpanel" aria-labelledby="view-tab-compare"
           aria-label="Shared dependency comparison" hidden>
    <div class="panel-head">
      <h2>Shared dependencies</h2>
      <div class="legend" id="matrix-legend"></div>
      <span class="hint" id="matrix-count"></span>
    </div>
    <div class="tab-body" id="matrix"></div>
  </section>

  <section class="panel view" id="view-doctor" role="tabpanel" aria-labelledby="view-tab-doctor" aria-label="Doctor findings" hidden>
    <div class="panel-head">
      <h2>Doctor findings</h2>
      <div class="chips" id="issue-chips"></div>
      <span class="hint" id="issue-count"></span>
    </div>
    <ul class="issues" id="issues"></ul>
  </section>
</div>

<div class="toast" id="toast" hidden></div>

<script>
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var W = 168, H = 78;
  // Standalone pill: right edge sits 32px inside the node, left of the status dot.
  var TAG_W = 62, TAG_RIGHT = 32;
  var graph = { apps: [], edges: [], findings: [], sharedMatrix: null };
  var selected = null;
  var tab = 'exposes';
  // Top-level view: 'apps', 'compare' or 'doctor'. Module state like the
  // inspector 'tab': SSE re-renders must never reset it back to the default.
  var view = 'apps';
  // Which top-level views exist, in arrow-key order (same order as the tabs).
  var VIEWS = ['apps', 'compare', 'doctor'];
  // Panel filters: error+warning visible by default, info hidden until the
  // chip enables it (same signal-to-noise rule as the CLI doctor panel).
  var showSeverity = { error: true, warning: true, info: false };
  // Finding codes the human expanded beyond the first row, e.g. code -> true.
  var expandedCodes = {};
  var svg = document.getElementById('graph');
  var toastTimer = null;

  // --- tiny DOM helpers (textContent only: manifests are untrusted) ---------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }
  function svgText(parent, attrs, value) {
    var node = svgEl('text', attrs, parent);
    // SVG text goes through createTextNode, never parsed markup.
    node.appendChild(document.createTextNode(String(value)));
    return node;
  }
  function toast(message) {
    var node = document.getElementById('toast');
    node.textContent = String(message);
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 2600);
  }

  function appByName(name) {
    for (var i = 0; i < graph.apps.length; i++) {
      if (graph.apps[i].name === name) return graph.apps[i];
    }
    return null;
  }
  function statusOf(app) {
    return app && app.status ? app.status : 'idle';
  }
  function portLabel(app) {
    return typeof app.port === 'number' ? ':' + app.port : 'no port';
  }
  function truthy(count) {
    return count > 0;
  }
  function findingsFor(name) {
    var out = [];
    for (var i = 0; i < graph.findings.length; i++) {
      var message = String(graph.findings[i].message);
      // Findings carry no app field (the doctor's message contract), so the
      // link is a name occurrence in the message. Cosmetic only: a wrong link
      // selects the wrong node, it never changes what is reported.
      if (message.indexOf(name) !== -1) out.push(graph.findings[i]);
    }
    return out;
  }

  // --- layout: host on the left, remotes stacked on the right --------------
  function layout() {
    var remotes = [];
    var host = null;
    for (var i = 0; i < graph.apps.length; i++) {
      if (graph.apps[i].role === 'host' && !host) host = graph.apps[i];
      else remotes.push(graph.apps[i]);
    }
    remotes.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var gapY = 26;
    var contentHeight = Math.max(1, remotes.length) * H + Math.max(0, remotes.length - 1) * gapY;
    var viewBoxHeight = Math.max(240, contentHeight + 60);
    var places = {};
    if (host) {
      places[host.name] = { x: 40, y: (viewBoxHeight - H) / 2 };
    }
    for (var r = 0; r < remotes.length; r++) {
      places[remotes[r].name] = { x: 40 + W + 140, y: 30 + r * (H + gapY) };
    }
    return { places: places, width: 40 + W + 140 + W + 40, height: viewBoxHeight };
  }

  // Edges inside one column must not run through the nodes between their
  // ends: they leave the right side, bow out into the margin (one lane per
  // overlapping edge so parallel edges never coincide) and come back onto the
  // target's right side, arrowhead pointing left at the target.
  var ARROW_GAP = 6;      // px the arrow tip stops short of the target border
  var BULGE_BASE = 30;    // how far lane 0 bows out past the column edge
  var LANE_STEP = 22;     // extra bow per lane so nested edges stay apart
  var ANCHOR_STEP = 10;   // vertical spread of the attach points per lane...
  var ANCHOR_LANES = 3;   // ...capped so they stay well inside the node (H = 78)
  var LABEL_NUDGE_STEPS = 8;  // how many slots a label may move up and down...
  var LABEL_NUDGE_PX = 20;    // ...and how far apart those slots sit
  function edgeGeometry(from, to, sameColumn, lane) {
    if (sameColumn) {
      var x1 = from.x + W;
      var x2 = to.x + W + ARROW_GAP;
      var shift = Math.min(lane, ANCHOR_LANES) * ANCHOR_STEP;
      var y1 = from.y + H / 2 + shift;
      var y2 = to.y + H / 2 + shift;
      var bulge = BULGE_BASE + lane * LANE_STEP;
      var reach = bulge / 0.75; // a cubic peaks at 3/4 of its control offset
      return {
        d: 'M' + x1 + ',' + y1 + ' C' + (x1 + reach) + ',' + y1 + ' ' +
          (x1 + reach) + ',' + y2 + ' ' + x2 + ',' + y2,
        lx: x1 + bulge + 6, ly: (y1 + y2) / 2 + 4, anchor: 'start'
      };
    }
    var cx1 = from.x + W, cy1 = from.y + H / 2;
    var cx2 = to.x - ARROW_GAP, cy2 = to.y + H / 2;
    var mx = (cx1 + cx2) / 2;
    return {
      d: 'M' + cx1 + ',' + cy1 + ' C' + mx + ',' + cy1 + ' ' + mx + ',' + cy2 + ' ' + cx2 + ',' + cy2,
      lx: mx, ly: (cy1 + cy2) / 2 - 6, anchor: 'middle'
    };
  }

  // Lane per same-column edge: the first lane no earlier edge with an
  // overlapping vertical span already uses.
  function assignLanes(edges, places) {
    var lanes = [];
    var spans = [];
    for (var i = 0; i < edges.length; i++) {
      var from = places[edges[i].from];
      var to = places[edges[i].to];
      lanes.push(0);
      if (!from || !to || from.x !== to.x) { spans.push(null); continue; }
      var span = [Math.min(from.y, to.y), Math.max(from.y, to.y), from.x];
      spans.push(span);
      var used = {};
      for (var j = 0; j < i; j++) {
        var other = spans[j];
        if (other && other[2] === span[2] && other[0] <= span[1] && span[0] <= other[1]) used[lanes[j]] = true;
      }
      while (used[lanes[i]]) lanes[i]++;
    }
    return lanes;
  }

  function labelRect(geometry, text) {
    var width = text.length * 6.8 + 10;
    var x = geometry.anchor === 'start' ? geometry.lx - 5 : geometry.lx - width / 2;
    return { x: x, y: geometry.ly - 12, width: width, height: 17 };
  }

  function overlapArea(a, b) {
    var w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    var h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }

  // Geometry and label slot for every edge, plus the bounds the labels need.
  // A label starts at the curve midpoint and is nudged vertically to the
  // nearest slot that touches no node or earlier label. If every slot within
  // reach is taken, the slot with the least overlap wins: placement is best
  // effort, not a guarantee. The bounds grow (also upwards) to hold every label.
  function planEdges(box, edges) {
    var obstacles = [];
    var placeNames = Object.keys(box.places);
    for (var o = 0; o < placeNames.length; o++) {
      var at = box.places[placeNames[o]];
      obstacles.push({ x: at.x, y: at.y, width: W, height: H });
    }
    var lanes = assignLanes(edges, box.places);
    var nudges = [0];
    for (var step = 1; step <= LABEL_NUDGE_STEPS; step++) nudges.push(-LABEL_NUDGE_PX * step, LABEL_NUDGE_PX * step);
    var items = [];
    var maxX = box.width;
    var minY = 0;
    var maxY = box.height;
    for (var e = 0; e < edges.length; e++) {
      var edge = edges[e];
      var from = box.places[edge.from];
      var to = box.places[edge.to];
      if (!from || !to) continue;
      var geometry = edgeGeometry(from, to, from.x === to.x, lanes[e]);
      var text = edge.label || '(app-level)';
      var baseY = geometry.ly;
      var bestY = baseY;
      var bestScore = Infinity;
      for (var t = 0; t < nudges.length && bestScore > 0; t++) {
        geometry.ly = baseY + nudges[t];
        var candidate = labelRect(geometry, text);
        var score = 0;
        for (var k = 0; k < obstacles.length; k++) score += overlapArea(candidate, obstacles[k]);
        if (score < bestScore) { bestScore = score; bestY = geometry.ly; }
      }
      geometry.ly = bestY;
      var rect = labelRect(geometry, text);
      obstacles.push(rect);
      maxX = Math.max(maxX, rect.x + rect.width + 16);
      minY = Math.min(minY, rect.y - 8);
      maxY = Math.max(maxY, rect.y + rect.height + 8);
      items.push({ edge: edge, geometry: geometry, text: text, rect: rect });
    }
    return { items: items, width: maxX, top: minY, height: maxY - minY };
  }

  function drawGraph() {
    clear(svg);
    var box = layout();
    var plan = planEdges(box, graph.edges);
    box.width = plan.width;
    svg.setAttribute('viewBox', '0 ' + plan.top + ' ' + box.width + ' ' + plan.height);

    var defs = svgEl('defs', {}, svg);
    var markers = [['arr', 'var(--ink-3)'], ['arr-hi', 'var(--accent)'], ['arr-bad', 'var(--bad-fill)']];
    for (var m = 0; m < markers.length; m++) {
      var marker = svgEl('marker', {
        id: markers[m][0], viewBox: '0 0 10 10', refX: '8', refY: '5',
        markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse'
      }, defs);
      svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: markers[m][1] }, marker);
    }
    for (var x = 20; x < box.width; x += 28) {
      for (var y = plan.top + 16; y < plan.top + plan.height; y += 28) {
        svgEl('circle', { cx: x, cy: y, r: 1, 'class': 'grid-dot' }, svg);
      }
    }

    for (var e = 0; e < plan.items.length; e++) {
      var item = plan.items[e];
      var highlighted = item.edge.from === selected || item.edge.to === selected;
      var classes = 'edge' + (item.edge.cyclic ? ' cycle' : '') + (highlighted ? ' hi' : '');
      var markerId = item.edge.cyclic ? 'arr-bad' : highlighted ? 'arr-hi' : 'arr';
      svgEl('path', {
        d: item.geometry.d, 'class': classes, 'marker-end': 'url(#' + markerId + ')',
        'data-edge': item.edge.from + '->' + item.edge.to
      }, svg);
    }
    for (var l = 0; l < plan.items.length; l++) {
      var planned = plan.items[l];
      var group = svgEl('g', {}, svg);
      svgEl('rect', {
        x: planned.rect.x, y: planned.rect.y, width: planned.rect.width,
        height: planned.rect.height, rx: 3, 'class': 'elabel-bg'
      }, group);
      svgText(group, {
        x: planned.geometry.lx, y: planned.geometry.ly, 'text-anchor': planned.geometry.anchor,
        'class': 'elabel' + (planned.edge.cyclic ? ' cycle' : '')
      }, planned.text);
    }

    var names = Object.keys(box.places).sort();
    for (var n = 0; n < names.length; n++) {
      var name = names[n];
      var app = appByName(name);
      if (!app) continue;
      var place = box.places[name];
      var errors = 0, warnings = 0;
      var own = findingsFor(name);
      for (var f = 0; f < own.length; f++) {
        if (own[f].severity === 'error') errors++;
        else if (own[f].severity === 'warning') warnings++;
      }
      var mentions = errors + warnings;
      var node = svgEl('g', {
        'class': 'node' + (name === selected ? ' sel' : ''),
        tabindex: '0', role: 'button',
        'aria-label': name + ', ' + app.role + ' on ' + portLabel(app) + ', ' + statusOf(app) +
          (app.standalone === true ? ', standalone' : '') +
          (truthy(mentions) ? ', ' + mentions + ' findings mention ' + name : ''),
        'data-node': name
      }, svg);
      if (truthy(mentions)) {
        // The badges count findings whose MESSAGE mentions this app (the
        // doctor's messages carry no app field). Label the badge group so it
        // is not misread as "findings belonging to this app".
        var tip = svgEl('title', {}, node);
        tip.appendChild(document.createTextNode(mentions + ' findings mention ' + name));
      }
      svgEl('rect', { x: place.x, y: place.y, width: W, height: H, rx: 9, 'class': 'box' }, node);
      svgText(node, { x: place.x + 14, y: place.y + 20, 'class': 'role' }, app.role.toUpperCase());
      svgText(node, { x: place.x + 14, y: place.y + 41, 'class': 'name' }, name);
      svgText(node, {
        x: place.x + 14, y: place.y + 62, 'class': 'meta'
      }, portLabel(app) + ' ' + statusOf(app) + ' ' + app.exposes.length + ' exp');
      if (app.standalone === true) {
        // Read-only declaration from the config; text node only, nowrap by
        // construction (fixed-width pill, single SVG text).
        svgEl('rect', {
          x: place.x + W - TAG_RIGHT - TAG_W, y: place.y + 8, width: TAG_W, height: 16, rx: 8,
          'class': 'tag-standalone'
        }, node);
        svgText(node, {
          x: place.x + W - TAG_RIGHT - TAG_W / 2, y: place.y + 19, 'text-anchor': 'middle',
          'class': 'tag-standalone-t'
        }, 'standalone');
      }
      svgEl('circle', {
        cx: place.x + W - 14, cy: place.y + 16, r: 4,
        fill: statusFill(app)
      }, node);
      var badgeX = place.x + W - 14;
      var badges = [['bad', errors, 'badge-c'], ['warn', warnings, 'badge-w']];
      for (var b = 0; b < badges.length; b++) {
        if (!truthy(badges[b][1])) continue;
        svgEl('circle', { cx: badgeX, cy: place.y + H - 16, r: 9, 'class': badges[b][2] }, node);
        svgText(node, {
          x: badgeX, y: place.y + H - 12, 'text-anchor': 'middle', 'class': 'badge-t'
        }, badges[b][1]);
        badgeX -= 22;
      }
      node.addEventListener('click', selectHandler(name));
      node.addEventListener('keydown', function (target) {
        return function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(target);
          }
        };
      }(name));
    }
  }

  function statusFill(app) {
    var status = statusOf(app);
    if (status === 'ready') return 'var(--teal)';
    if (status === 'starting' || status === 'bundling') return 'var(--warn-fill)';
    if (status === 'error') return 'var(--bad-fill)';
    return 'var(--ink-3)';
  }

  function selectHandler(name) {
    return function () { select(name); };
  }

  function expandHandler(code) {
    return function () {
      if (expandedCodes[code]) delete expandedCodes[code];
      else expandedCodes[code] = true;
      renderIssues();
    };
  }

  function renderViewTabs() {
    var buttons = document.getElementById('view-tabs').querySelectorAll('.view-tab');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-selected',
        String(buttons[i].getAttribute('data-view') === view));
    }
    document.getElementById('view-apps').hidden = view !== 'apps';
    document.getElementById('view-compare').hidden = view !== 'compare';
    document.getElementById('view-doctor').hidden = view !== 'doctor';
  }

  function setView(name) {
    view = name;
    renderViewTabs();
  }

  function select(name, requestedTab) {
    if (!appByName(name)) return;
    selected = name;
    if (requestedTab) tab = requestedTab;
    render();
  }

  // --- inspector ------------------------------------------------------------
  function renderSessions() {
    var host = document.getElementById('sessions');
    clear(host);
    var apps = graph.apps.slice().sort(function (a, b) {
      if (a.role !== b.role) return a.role === 'host' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (var i = 0; i < apps.length; i++) {
      var pill = el('button', 'sess');
      pill.type = 'button';
      pill.setAttribute('data-app', apps[i].name);
      var dot = el('span', 'dot dot-' + statusOf(apps[i]));
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(
        apps[i].name + (typeof apps[i].port === 'number' ? ' :' + apps[i].port : '') +
        ' \\u00b7 ' + statusOf(apps[i])
      ));
      pill.title = apps[i].name + ' ' + portLabel(apps[i]) + ' ' + statusOf(apps[i]);
      pill.addEventListener('click', selectHandler(apps[i].name));
      host.appendChild(pill);
    }
  }

  function sectionTitle(title, count) {
    return el('div', 'sec-title', title + ' \\u00b7 ' + count);
  }

  function hint(text) {
    return el('p', 'hint', text);
  }

  function pathNode(path) {
    var parts = String(path).split('/');
    var span = el('span', 'path');
    if (parts.length > 1) {
      span.appendChild(document.createTextNode(parts.slice(0, -1).join('/') + '/'));
    }
    span.appendChild(el('b', null, parts[parts.length - 1]));
    return span;
  }

  function copySnippet(line, host) {
    var done = function () { toast('Copied. Paste it into exposes and commit it with the consumer change.'); };
    var fallback = function () {
      // Textarea + execCommand: the only portable path when the Clipboard API
      // is unavailable (plain http on a non-localhost origin, older browsers).
      var area = document.createElement('textarea');
      area.value = line;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      host.appendChild(area);
      area.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
      host.removeChild(area);
      if (copied) { done(); return; }
      var pre = document.createElement('pre');
      pre.className = 'snippet';
      pre.textContent = line;
      host.appendChild(pre);
      toast('Copying is blocked here. The snippet is shown below for manual copy.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(line).then(done, fallback);
      return;
    }
    fallback();
  }

  function renderExposes(app, body) {
    body.appendChild(hint(app.role === 'host'
      ? 'The host exposes nothing. Exposed modules are a public contract: other apps build against them and old app versions keep loading them.'
      : 'Read-only view of this container. Exposing a file makes it a public contract, so the change belongs in your config and your PR.'));

    if (!app.detection.manifestAvailable) {
      body.appendChild(hint('No federation manifest was loaded for this app, so nothing below can be answered from it.'));
      return;
    }
    if (!truthy(app.exposes.length)) {
      body.appendChild(hint('This app exposes no modules.'));
      return;
    }

    body.appendChild(sectionTitle('Exposed', app.exposes.length));
    var list = el('ul', 'files');
    for (var i = 0; i < app.exposes.length; i++) {
      var expose = app.exposes[i];
      var item = el('li');
      item.appendChild(pathNode(expose.path));
      item.appendChild(el('span', 'exp-name', './' + expose.name));

      var consumers = el('div', 'used-by');
      if (truthy(expose.consumers.length)) {
        consumers.className = 'used-by warn';
        consumers.appendChild(document.createTextNode(
          'Consumed by ' + expose.consumers.join(', ') +
          '. Renaming or removing it breaks them at runtime.'
        ));
      } else if (truthy(app.consumedBy.length)) {
        consumers.appendChild(document.createTextNode(
          'Not referenced by module name in any manifest, but ' +
          app.consumedBy.join(', ') + ' loads this container. Manifests record ' +
          'container-level references, so the exact module is not provable here.'
        ));
      } else {
        consumers.appendChild(document.createTextNode(
          'Not consumed by any app in this workspace.'
        ));
      }
      item.appendChild(consumers);

      var exposeKey = "'" + './' + expose.name + "': '" + expose.path + "',";
      var button = el('button', 'btn', 'Copy snippet');
      button.type = 'button';
      button.setAttribute('data-snippet', './' + expose.name);
      button.addEventListener('click', (function (line, target) {
        return function () { copySnippet(line, target); };
      })(exposeKey, item));
      item.appendChild(button);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  function table(headers) {
    var wrapper = el('div', 'scroll-x');
    var tableNode = el('table', 'kv');
    var head = el('thead');
    var row = el('tr');
    for (var i = 0; i < headers.length; i++) row.appendChild(el('th', null, headers[i]));
    head.appendChild(row);
    tableNode.appendChild(head);
    var bodyNode = el('tbody');
    tableNode.appendChild(bodyNode);
    wrapper.appendChild(tableNode);
    return { wrapper: wrapper, body: bodyNode };
  }

  function row(cells) {
    var rowNode = el('tr');
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      // One class per cell; precedence: plain > pill > nowrap.
      var cellClass = null;
      if (cell.plain) cellClass = 'st';
      else if (cell.pill) cellClass = 'has-pill';
      else if (cell.nowrap) cellClass = 'nowrap';
      var td = el('td', cellClass);
      if (cell.pill) {
        var pill = el('span', 'pill ' + cell.pill, cell.text);
        td.appendChild(pill);
      } else {
        td.appendChild(document.createTextNode(String(cell.text)));
      }
      rowNode.appendChild(td);
    }
    return rowNode;
  }

  function renderShared(app, body) {
    body.appendChild(hint('Shared declarations of this app. Cross-app drift is what the doctor panel below reports, because drift is only visible when two apps are compared.'));
    if (!truthy(app.shared.length)) {
      body.appendChild(hint('This app declares no shared dependencies.'));
      return;
    }
    var built = table(['Package', 'Version', 'Required', 'Singleton', 'Eager']);
    for (var i = 0; i < app.shared.length; i++) {
      var entry = app.shared[i];
      built.body.appendChild(row([
        { text: entry.name },
        { text: entry.version },
        { text: entry.requiredVersion },
        { text: entry.singleton ? 'yes' : 'no', plain: true },
        { text: entry.eager ? 'yes' : 'no', plain: true }
      ]));
    }
    body.appendChild(built.wrapper);
  }

  function renderNative(app, body) {
    body.appendChild(hint('JavaScript can be downloaded later; native code cannot. Every module a remote uses has to ship in the host binary.'));
    var detection = app.detection;
    if (truthy(detection.platforms.length)) {
      body.appendChild(hint('React Native ' + (detection.reactNativeVersion || 'unknown') +
        ' \\u00b7 new architecture: ' + (detection.newArch === undefined ? 'unknown' : detection.newArch ? 'yes' : 'no') +
        ' \\u00b7 platforms: ' + detection.platforms.join(', ')));
    }
    if (detection.dynamicImportDetected) {
      body.appendChild(el('p', 'hint', 'Dynamic imports were detected in this app, so the native-module list below may be incomplete: findings about it are advisories, not verdicts.'));
    }
    if (!truthy(app.native.length)) {
      body.appendChild(hint(detection.manifestAvailable
        ? 'No native module was detected in this app (detection is static plus heuristic; absence here is not a guarantee).'
        : 'No native module data: no manifest was loaded for this app.'));
      return;
    }
    var built = table(['Native module', 'Version', 'Turbo module', 'Detection']);
    for (var i = 0; i < app.native.length; i++) {
      var entry = app.native[i];
      built.body.appendChild(row([
        { text: entry['package'] },
        { text: entry.version, nowrap: true },
        { text: entry.turboModule ? 'yes' : 'no', plain: true },
        { text: entry.confidence, pill: entry.confidence === 'heuristic' ? 'warn' : 'ok' }
      ]));
    }
    body.appendChild(built.wrapper);
  }

  function renderBundle(app, body) {
    body.appendChild(hint('Bundle sizes need the compiler stats of a running build. The Studio answers from federation manifests only, which do not carry size data.'));
    body.appendChild(hint('No bundle data available' + (app ? ' for ' + app.name : '') + '. Run the workspace with the dev runner, or open the build in a stats viewer.'));
  }

  function renderInspector() {
    var app = appByName(selected);
    var nameNode = document.getElementById('insp-name');
    var metaNode = document.getElementById('insp-meta');
    clear(nameNode);
    clear(metaNode);
    if (!app) {
      nameNode.appendChild(document.createTextNode('No app selected'));
      clear(document.getElementById('tab-body'));
      return;
    }
    nameNode.appendChild(document.createTextNode(app.name));
    metaNode.appendChild(document.createTextNode(
      app.role.toUpperCase() + ' ' + portLabel(app) + ' ' + statusOf(app) +
      (app.standalone === true ? ' \\u00b7 standalone' : '') +
      (truthy(app.consumedBy.length) ? ' \\u2190 used by ' + app.consumedBy.join(', ') : '')
    ));

    var tabs = document.getElementById('tabs').querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', String(tabs[i].getAttribute('data-tab') === tab));
    }
    var body = clear(document.getElementById('tab-body'));
    if (tab === 'shared') renderShared(app, body);
    else if (tab === 'native') renderNative(app, body);
    else if (tab === 'bundle') renderBundle(app, body);
    else renderExposes(app, body);
  }

  function severityTotal(severity) {
    var count = 0;
    for (var i = 0; i < graph.findings.length; i++) {
      if (graph.findings[i].severity === severity) count++;
    }
    return count;
  }

  function renderIssueChips() {
    var host = clear(document.getElementById('issue-chips'));
    var chips = [
      ['error', 'errors'],
      ['warning', 'warnings'],
      ['info', 'infos']
    ];
    for (var c = 0; c < chips.length; c++) {
      var chip = el('button', 'chip', chips[c][1] + ' (' + severityTotal(chips[c][0]) + ')');
      chip.type = 'button';
      chip.setAttribute('data-severity', chips[c][1]);
      chip.setAttribute('aria-pressed', String(showSeverity[chips[c][0]] === true));
      chip.addEventListener('click', (function (key) {
        return function () {
          showSeverity[key] = !showSeverity[key];
          renderIssues();
        };
      })(chips[c][0]));
      host.appendChild(chip);
    }
  }

  function issueRow(finding) {
    var item = el('li');
    var button = el('button', 'issue');
    button.type = 'button';
    button.setAttribute('data-code', String(finding.code));
    button.appendChild(el('span', 'stripe' + (finding.severity === 'error' ? ' bad' : finding.severity === 'info' ? ' info' : '')));
    button.appendChild(el('span', 'code', String(finding.code)));
    button.appendChild(el('span', 'msg', String(finding.message)));
    button.appendChild(el('span', 'where', finding.confidence === 'heuristic' ? 'heuristic' : 'static'));
    button.addEventListener('click', function (candidate) {
      return function () {
        for (var a = 0; a < graph.apps.length; a++) {
          if (String(candidate.message).indexOf(graph.apps[a].name) !== -1) {
            // The jump must keep working across the top-level tabs: a row in
            // the Doctor view selects an app that lives in the Apps view.
            setView('apps');
            select(graph.apps[a].name);
            return;
          }
        }
      };
    }(finding));
    item.appendChild(button);
    return item;
  }

  // Apps-view panel: the findings that mention the selected app, no chips
  // and no per-code collapse (the subsets are small; keep it a plain list).
  // The listed set is the badge set (error + warning), so the header count
  // and the node badge can never disagree; infos are counted in a hint and
  // listed in the Doctor tab.
  function renderAppFindings() {
    var heading = document.getElementById('app-findings-title');
    var list = clear(document.getElementById('app-issues'));
    var app = appByName(selected);
    if (!app) {
      heading.textContent = 'Findings';
      list.appendChild(el('li', 'hint', 'Select an app to see the findings that mention it.'));
      return;
    }
    var mentions = findingsFor(app.name);
    var shown = [];
    var hiddenInfos = 0;
    for (var m = 0; m < mentions.length; m++) {
      if (mentions[m].severity === 'info') hiddenInfos++;
      else shown.push(mentions[m]);
    }
    heading.textContent = 'Findings \\u00b7 ' + app.name + ' (' + shown.length + ')';
    if (!truthy(shown.length) && !truthy(hiddenInfos)) {
      list.appendChild(el('li', 'hint', 'No findings mention ' + app.name + '.'));
      return;
    }
    for (var i = 0; i < shown.length; i++) list.appendChild(issueRow(shown[i]));
    if (truthy(hiddenInfos)) {
      list.appendChild(el('li', 'hint', hiddenInfos + ' info ' +
        (hiddenInfos === 1 ? 'finding' : 'findings') +
        ' hidden \\u2014 the Doctor tab lists them.'));
    }
  }

  // --- Compare view: the shared-dependency matrix (issue #73) --------------
  // The verdicts come from core (graph.sharedMatrix, built by buildSharedMatrix
  // in src/core/graph.ts): this page only maps a status to a pill class and
  // some text, it never compares two versions itself.
  var MATRIX_STATUS = {
    reference: { pill: 'ref', text: 'reference' },
    match: { pill: 'ok', text: 'match' },
    drift: { pill: 'bad', text: 'drift' },
    'singleton-mismatch': { pill: 'bad', text: 'singleton' },
    unknown: { pill: 'warn', text: 'unknown' },
    coexist: { pill: 'mute', text: 'coexists' },
    absent: { pill: 'mute', text: 'not declared' },
    uncompared: { pill: 'mute', text: 'no reference' }
  };

  function matrixStatus(status) {
    // An unknown status (a newer core) says what it is: never guess a colour.
    return MATRIX_STATUS[status] || { pill: 'mute', text: String(status) };
  }

  function renderMatrixLegend(host) {
    var entries = [
      ['ref', 'reference', 'the column every other app is compared against'],
      ['ok', 'match', 'same version and same singleton flag'],
      ['bad', 'drift', 'both singleton with different versions, or the flags differ'],
      ['warn', 'unknown', 'a version could not be resolved \\u2014 verify it manually'],
      ['mute', 'n/a', 'not comparable: not declared, or nothing to compare against']
    ];
    for (var i = 0; i < entries.length; i++) {
      var span = el('span');
      span.appendChild(el('span', 'pill ' + entries[i][0], entries[i][1]));
      span.appendChild(document.createTextNode(' ' + entries[i][2]));
      host.appendChild(span);
    }
  }

  function matrixCountText(matrix, conflicts) {
    return plural(matrix.rows.length, 'package') + ' \\u00b7 ' +
      plural(matrix.apps.length, 'app') + ' \\u00b7 ' +
      plural(conflicts, 'conflict');
  }

  function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function renderMatrix() {
    var host = clear(document.getElementById('matrix'));
    var legend = clear(document.getElementById('matrix-legend'));
    var count = document.getElementById('matrix-count');
    var matrix = graph.sharedMatrix;

    if (!matrix || !Array.isArray(matrix.rows) || !Array.isArray(matrix.apps) ||
        !matrix.apps.length) {
      count.textContent = '';
      host.appendChild(hint('No shared-dependency data: no app in this workspace reported shared declarations.'));
      return;
    }

    var conflicts = 0;
    for (var r = 0; r < matrix.rows.length; r++) {
      for (var c = 0; c < matrix.rows[r].cells.length; c++) {
        var status = matrix.rows[r].cells[c].status;
        if (status === 'drift' || status === 'singleton-mismatch') conflicts++;
      }
    }
    count.textContent = matrixCountText(matrix, conflicts);

    // Honest scope (AGENTS.md rule 7): core compares each app against the host
    // only, exactly like the doctor does; remote-vs-remote is issue #55.
    host.appendChild(hint('Every app is compared against ' +
      (matrix.referenceApp
        ? 'the host "' + matrix.referenceApp + '"'
        : 'no reference \\u2014 this workspace reports no host') +
      ', the same comparison the Doctor makes. Two remotes that disagree with each ' +
      'other while both agreeing with the host are not reported here, and "unknown" ' +
      'is never a pass.'));

    var built = table(['Package', 'Singleton'].concat(matrix.apps));
    // The package column sticks to the left while the app columns scroll.
    var firstHead = built.wrapper.querySelector('th');
    if (firstHead) firstHead.className = 'pkg';
    for (var i = 0; i < matrix.rows.length; i++) {
      var matrixRow = matrix.rows[i];
      var rowNode = el('tr');
      rowNode.appendChild(el('td', 'pkg', matrixRow.package));
      // The Singleton column reports the REFERENCE declaration only: when the
      // host never declared the package there is no declaration to report, and
      // printing "no" would be a claim the data does not support (rule 7).
      rowNode.appendChild(el('td', 'st', matrixRow.referenceDeclares
        ? (matrixRow.singleton ? 'yes' : 'no')
        : 'not on host'));
      for (var j = 0; j < matrixRow.cells.length; j++) {
        rowNode.appendChild(matrixCell(matrixRow.package, matrixRow.cells[j]));
      }
      built.body.appendChild(rowNode);
    }
    host.appendChild(built.wrapper);
    renderMatrixLegend(legend);
  }

  function matrixCell(pkg, cell) {
    var shown = matrixStatus(cell.status);
    var td = el('td', 'verdict');
    td.title = cell.app + ' \\u00b7 ' + pkg + ': ' + shown.text +
      (cell.declared
        ? ' \\u00b7 version ' + (cell.version || 'unknown') +
          ' \\u00b7 singleton ' + (cell.singleton ? 'yes' : 'no')
        : ' \\u00b7 not declared') +
      (cell.requiredVersion ? ' \\u00b7 requires ' + cell.requiredVersion : '');
    if (!cell.declared) {
      // A bare dash: a pill here would read as a verdict about nothing.
      td.appendChild(document.createTextNode('\\u2014'));
    } else {
      td.appendChild(el('span', 'pill ' + shown.pill, shown.text));
      if (cell.version) {
        td.appendChild(document.createTextNode(' ' + cell.version));
      }
    }
    return td;
  }

  function renderIssues() {
    renderIssueChips();
    var list = clear(document.getElementById('issues'));
    var errors = severityTotal('error');
    var warnings = severityTotal('warning');
    var infos = severityTotal('info');

    // Group visible findings by code, first-occurrence order; groups larger
    // than one collapse behind a "+ N more" button, collapsed by default
    // (same signal-to-noise rule as the CLI doctor panel).
    var order = [];
    var groups = {};
    var hiddenInfos = 0;
    for (var i = 0; i < graph.findings.length; i++) {
      var finding = graph.findings[i];
      var severity = finding.severity;
      if (showSeverity[severity] !== true) {
        if (severity === 'info') hiddenInfos++;
        continue;
      }
      var code = String(finding.code);
      if (!groups[code]) { groups[code] = []; order.push(code); }
      groups[code].push(finding);
    }

    var visibleRows = 0;
    for (var g = 0; g < order.length; g++) {
      var groupCode = order[g];
      var findings = groups[groupCode];
      var expanded = expandedCodes[groupCode] === true;
      list.appendChild(issueRow(findings[0]));
      visibleRows++;
      if (!expanded) {
        if (findings.length > 1) {
          list.appendChild(moreButton(groupCode, false,
            '+ ' + (findings.length - 1) + ' more ' + groupCode + ' \\u2014 click to expand all'));
        }
      } else {
        for (var r = 1; r < findings.length; r++) {
          list.appendChild(issueRow(findings[r]));
          visibleRows++;
        }
        list.appendChild(moreButton(groupCode, true,
          '\\u25b4 ' + findings.length + ' ' + groupCode + ' \\u2014 click to collapse'));
      }
    }

    if (!truthy(visibleRows)) {
      list.appendChild(el('li', 'hint', truthy(graph.findings.length)
        ? (truthy(hiddenInfos)
          ? 'infos are hidden \\u2014 enable the infos chip to show them'
          : 'No findings match the selected severities.')
        : 'No findings.'));
    }
    document.getElementById('issue-count').textContent =
      errors + ' errors \\u00b7 ' + warnings + ' warnings \\u00b7 ' + infos + ' infos';
  }

  // The "+ N more" / collapse toggle of a code group (Doctor view only).
  function moreButton(code, expanded, text) {
    var button = el('button', 'issue-more');
    button.type = 'button';
    button.setAttribute('data-code', code);
    button.setAttribute('aria-pressed', String(expanded));
    button.textContent = text;
    button.addEventListener('click', expandHandler(code));
    return button;
  }

  function render() {
    renderViewTabs();
    drawGraph();
    renderSessions();
    renderInspector();
    renderAppFindings();
    renderMatrix();
    renderIssues();
  }

  function setLive(state, text) {
    var node = document.getElementById('live');
    node.setAttribute('data-state', state);
    node.className = 'live' + (state === 'error' ? ' err' : '');
    node.textContent = text;
  }

  // --- data: initial fetch + SSE with backoff ------------------------------
  function applyGraph(payload) {
    if (!payload || !Array.isArray(payload.apps)) return;
    graph = {
      apps: payload.apps,
      edges: Array.isArray(payload.edges) ? payload.edges : [],
      findings: Array.isArray(payload.findings) ? payload.findings : [],
      sharedMatrix: payload.sharedMatrix && typeof payload.sharedMatrix === 'object'
        ? payload.sharedMatrix : null
    };
    if (!appByName(selected)) {
      selected = graph.apps.length > 0
        ? (graph.apps.filter(function (app) { return app.role === 'host'; })[0] || graph.apps[0]).name
        : null;
    }
    render();
  }

  function loadGraph() {
    return fetch('api/graph', { headers: { accept: 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(applyGraph)
      .catch(function () {
      /* unreachable dev server: the SSE stream or a later retry fixes it */
    });
  }

  function connect() {
    var attempt = 0;
    var source;
    try {
      source = new EventSource('api/events');
    } catch (error) {
      setLive('error', 'stream unavailable');
      return;
    }
    source.addEventListener('open', function () {
      attempt = 0;
      setLive('live', 'live');
      loadGraph();
    });
    source.addEventListener('graph', function (event) {
      // A malformed frame must not stop the stream or poison the view.
      try { applyGraph(JSON.parse(event.data)); } catch (error) { /* ignore it */ }
    });
    source.addEventListener('error', function () {
      setLive('error', 'reconnecting');
      if (source.readyState === 2 /* CLOSED */) {
        // EventSource gives up on its own only while the document is alive;
        // back off and build a fresh one so a server restart recovers.
        attempt += 1;
        var delay = Math.min(15000, 500 * Math.pow(2, attempt));
        setTimeout(connect, delay);
      }
    });
  }

  document.getElementById('tabs').addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('.tab') : null;
    if (button) {
      tab = button.getAttribute('data-tab');
      renderInspector();
    }
  });

  var viewTabs = document.getElementById('view-tabs');
  viewTabs.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('.view-tab') : null;
    if (button) setView(button.getAttribute('data-view'));
  });
  viewTabs.addEventListener('keydown', function (event) {
    var views = VIEWS;
    var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? views.length - 1 : 0;
    if (!step) return;
    event.preventDefault();
    var next = views[(views.indexOf(view) + step) % views.length];
    setView(next);
    document.getElementById('view-tab-' + next).focus();
  });

  document.getElementById('workspace-url').textContent = window.location.host;
  document.getElementById('issue-count').textContent = '';
  loadGraph().then(connect);
}());
</script>
</body>
</html>
`;

/** Exported so tests and the dev preview can assert the offline/security rules. */
export function studioPageHtml(): string {
  return STUDIO_PAGE_HTML;
}
