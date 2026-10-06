// Static guards on the Studio page string (docs/PRD.md §7.2/§7.3).
//
// These are the rules that cannot be verified by rendering: the page must not
// contain the mechanisms that break them (external loads, innerHTML). The
// behavioral proof lives in tests/e2e/studio.spec.ts; this file is the cheap
// regression net that fires even when Playwright cannot run.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { STUDIO_PAGE_HTML, studioPageHtml } from '../../src/studio/page.js';

const page = studioPageHtml();

/** Every `src=`/`href=` value in the markup, attribute form only. */
function loadableTargets(html: string): string[] {
  return [...html.matchAll(/(?:src|href)\s*=\s*("([^"]*)"|'([^']*)')/g)].map(
    (match) => match[2] ?? match[3] ?? ''
  );
}

describe('Studio page is offline-safe', () => {
  it('exports a non-empty HTML document', () => {
    assert.equal(page, STUDIO_PAGE_HTML);
    assert.match(page, /^<!doctype html>/, 'starts with the doctype');
    assert.match(page, /<\/html>\s*$/, 'ends with </html>');
  });

  it('references no external resource', () => {
    assert.deepEqual(loadableTargets(page), [], 'no src=/href= attributes at all');
  });

  it('contains no url()-bearing CSS import', () => {
    assert.ok(!page.includes('@import'), 'no CSS @import');
    assert.doesNotMatch(page, /url\(\s*['"]?(https?:)?\/\//, 'no url() load');
  });

  it('carries no font loading of any kind', () => {
    assert.doesNotMatch(page, /fonts\.googleapis|fonts\.gstatic|@font-face/, 'no webfonts');
    // Font stacks stay system-only.
    assert.match(page, /--sans: -apple-system/);
    assert.match(page, /--mono: ui-monospace/);
  });

  it('fetches only its own relative API routes', () => {
    const fetches = [...page.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
    const streams = [...page.matchAll(/EventSource\('([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(fetches, ['api/graph']);
    assert.deepEqual(streams, ['api/events']);
  });
});

describe('Studio page renders untrusted data as text only', () => {
  it('never uses innerHTML or outerHTML', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!page.includes(forbidden), `page must not use ${forbidden}`);
    }
  });

  it('builds DOM through createElement / createTextNode / createElementNS', () => {
    assert.match(page, /document\.createElement\(/);
    assert.match(page, /document\.createTextNode\(/);
    assert.match(page, /document\.createElementNS\(/);
    // The SVG namespace identifier is data, not a network load: it is the only
    // absolute URL allowed in the document.
    const absoluteUrls = page.match(/https?:\/\/[^"'()\s]+/g) ?? [];
    assert.deepEqual(absoluteUrls, ['http://www.w3.org/2000/svg']);
  });

  it('never evaluates data as code', () => {
    assert.doesNotMatch(page, /\beval\(/, 'no eval');
    assert.doesNotMatch(page, /new Function\(/, 'no Function constructor');
    assert.doesNotMatch(page, /setTimeout\(\s*['"]/, 'no string timers');
  });

  it('offers no way to mutate anything', () => {
    for (const forbidden of ['<form', '<input', '<textarea']) {
      // The copy fallback builds its textarea in JS, never in markup.
      assert.ok(!page.includes(forbidden), `page markup must not contain ${forbidden}`);
    }
    assert.doesNotMatch(page, /method=["']post/i, 'no form POST');
    assert.doesNotMatch(page, /fetch\([^)]*method/, 'no non-GET fetch');
  });
});

describe('Studio page keeps the mock design tokens', () => {
  const tokens: Record<string, string> = {
    'accent light': '#8232ff',
    'accent dark': '#9b6dff',
    'logo gradient end': '#3ce4cb',
    'ground light': '#f9f8fd',
    'ground dark': '#18171b',
  };

  for (const [label, token] of Object.entries(tokens)) {
    it(`uses ${label} (${token})`, () => {
      assert.ok(page.includes(token), `missing ${label}`);
    });
  }

  it('supports light and dark through prefers-color-scheme', () => {
    assert.match(page, /@media \(prefers-color-scheme: dark\)/);
    assert.match(page, /name="color-scheme" content="light dark"/);
  });

  it('respects reduced motion', () => {
    assert.match(page, /@media \(prefers-reduced-motion: no-preference\)/);
  });

  it('keeps the mock layout proportions and node size', () => {
    assert.match(page, /grid-template-columns: minmax\(0, 1\.55fr\) minmax\(0, 1fr\)/);
    assert.match(page, /var W = 168, H = 78/);
    assert.match(page, /rx: 9/);
    assert.match(page, /stroke-dasharray: 6 4/);
  });

  it('exposes the four inspector tabs and keyboard-focusable nodes', () => {
    for (const tab of ['exposes', 'shared', 'native', 'bundle']) {
      assert.ok(page.includes(`data-tab="${tab}"`), `missing tab ${tab}`);
    }
    assert.match(page, /role: 'button'/);
    assert.match(page, /tabindex: '0'/);
    assert.match(page, /:focus-visible rect\.box/);
  });

  it('does not scroll horizontally', () => {
    assert.match(page, /body \{[\s\S]*?overflow-x: hidden/);
    assert.match(page, /\.graph-box \{ overflow: hidden; \}/);
  });

  it('states the read-only contract in the UI copy', () => {
    assert.match(page, /belongs in your config and your PR/);
    assert.match(page, /Copy snippet/);
    assert.match(page, /No bundle data available/);
  });
});

describe('Studio page keeps badges on one line', () => {
  it('never lets a pill or a pill cell wrap', () => {
    assert.match(page, /\.pill \{[^}]*white-space: nowrap/);
    assert.match(page, /table\.kv td\.has-pill \{[^}]*white-space: nowrap/);
  });
});

describe('Studio page standalone badge', () => {
  it('source draws the badge from app.standalone with a literal label', () => {
    assert.match(page, /app\.standalone === true/);
    assert.match(page, /'standalone'\);/, 'literal label, never data');
    assert.match(page, /\.tag-standalone-t/);
  });
});

describe('Studio page Compare view (shared-dependency matrix)', () => {
  it('offers a Compare tab between Apps and Doctor', () => {
    assert.match(
      page,
      /id="view-tab-compare"\s+data-view="compare"\s+aria-selected="false"\s+aria-controls="view-compare">Compare</,
      'the Compare tab button exists with its aria wiring'
    );
    const position = (view: string): number => page.indexOf(`id="view-tab-${view}"`);
    assert.ok(
      position('apps') >= 0 && position('apps') < position('compare'),
      'Compare sits after Apps'
    );
    assert.ok(
      position('compare') < position('doctor'),
      'Compare sits before Doctor'
    );
  });

  it('ships a hidden Compare panel labelled by its tab', () => {
    const panel = page.match(/<section[^>]*id="view-compare"[^>]*>/);
    assert.ok(panel, 'the view-compare section exists');
    for (const fragment of [
      'class="panel view"',
      'role="tabpanel"',
      'aria-labelledby="view-tab-compare"',
      'aria-label="Shared dependency comparison"',
      'hidden',
    ]) {
      assert.ok(panel[0].includes(fragment), `panel carries ${fragment}`);
    }
    assert.match(page, /<h2>Shared dependencies<\/h2>/, 'panel heading');
    assert.match(page, /id="matrix-legend"/, 'legend slot');
    assert.match(page, /id="matrix-count"/, 'count slot');
    assert.match(page, /class="tab-body" id="matrix"/, 'matrix slot');
  });

  it('lists the three views in tab order for the arrow-key handler', () => {
    assert.match(page, /var VIEWS = \['apps', 'compare', 'doctor'\];/);
    assert.match(page, /document\.getElementById\('view-compare'\)\.hidden = view !== 'compare';/);
  });

  it('draws the matrix from core data through text nodes only', () => {
    // The page must not judge: verdicts come from graph.sharedMatrix.
    assert.match(page, /var matrix = graph\.sharedMatrix;/);
    assert.match(page, /function renderMatrix\(\)/);
    assert.match(page, /renderMatrix\(\);/, 'renderMatrix runs with the view render');
    // Verdict text rides text nodes inside a pill span; an undeclared cell is
    // a bare em dash, never a pill about nothing.
    assert.match(page, /td\.appendChild\(document\.createTextNode\('\\u2014'\)\);/);
    assert.match(page, /el\('span', 'pill ' \+ shown\.pill, shown\.text\)/);
    assert.match(page, /el\('td', 'pkg', matrixRow\.package\)/, 'sticky package column');
  });

  it('keeps the status-to-pill mapping honest', () => {
    const mapping: [string, string][] = [
      ['reference', 'ref'],
      ['match', 'ok'],
      ['drift', 'bad'],
      ["'singleton-mismatch'", 'bad'],
      ['unknown', 'warn'],
      ['coexist', 'mute'],
      ['absent', 'mute'],
      ['uncompared', 'mute'],
    ];
    for (const [status, pill] of mapping) {
      assert.match(
        page,
        new RegExp(`${status}: \\{ pill: '${pill}'`),
        `${status} maps to the ${pill} pill`
      );
    }
    // Unknown must not be dressed as a pass.
    assert.match(page, /unknown: \{ pill: 'warn'/);
  });

  it('states the comparison scope instead of implying exhaustiveness', () => {
    assert.ok(
      page.includes('Every app is compared against '),
      'hint names the reference app'
    );
    assert.ok(
      page.includes("'the host \"' + matrix.referenceApp + '\"'"),
      'hint quotes the host'
    );
    assert.ok(
      page.includes('Two remotes that disagree with each '),
      'hint states that remote-vs-remote is out of scope'
    );
    assert.ok(
      page.includes('is never a pass.'),
      'hint states that unknown is never a pass'
    );
  });

  it('says so when the payload carries no usable matrix', () => {
    assert.match(
      page,
      /No shared-dependency data: no app in this workspace reported shared declarations\./
    );
    assert.match(page, /count\.textContent = '';/, 'count is cleared, not guessed');
  });
});

interface PlannedItem {
  geometry: { ly: number };
  rect: { x: number; y: number; width: number; height: number };
}
type PlanEdges = (
  box: { places: Record<string, { x: number; y: number }>; width: number; height: number },
  edges: { from: string; to: string; label: string }[]
) => { items: PlannedItem[] };

/**
 * Load the page's pure layout functions (constants through planEdges) into a
 * bare vm context. The span holds no DOM access, so no document is provided.
 */
function loadPlanEdges(): {
  planEdges: PlanEdges;
  nodeWidth: number;
  nodeHeight: number;
  nudgeSteps: number;
  nudgePx: number;
} {
  const script = page.slice(page.indexOf('<script>'));
  const size = script.match(/var W = (\d+), H = (\d+);/);
  const from = script.indexOf('var ARROW_GAP');
  const to = script.indexOf('function drawGraph');
  const steps = script.match(/var LABEL_NUDGE_STEPS = (\d+);/);
  const px = script.match(/var LABEL_NUDGE_PX = (\d+);/);
  assert.ok(steps && px, 'label nudge constants found in the page script');
  assert.ok(size && from > 0 && to > from, 'layout span found in the page script');
  const nodeWidth = Number(size[1]);
  const nodeHeight = Number(size[2]);
  const context = vm.createContext({ W: nodeWidth, H: nodeHeight });
  vm.runInContext(script.slice(from, to), context);
  return {
    planEdges: (context as { planEdges: PlanEdges }).planEdges,
    nodeWidth,
    nodeHeight,
    nudgeSteps: Number(steps[1]),
    nudgePx: Number(px[1]),
  };
}

describe('Studio edge label placement', () => {
  const { planEdges, nodeWidth, nodeHeight, nudgeSteps, nudgePx } = loadPlanEdges();
  const edges = [{ from: 'a', to: 'b', label: 'x' }];
  const ends = { a: { x: 0, y: 0 }, b: { x: 700, y: 200 } };

  it('falls back to the slot with the least overlap when every slot is blocked', () => {
    const free = planEdges({ places: { ...ends }, width: 900, height: 400 }, edges).items[0]!;
    const baseLy = free.geometry.ly;
    const labelHeight = free.rect.height;
    // The gap [gapStart, gapEnd] must be non-empty for the geometry below to
    // clip the target slot less than the fully blocked ones.
    const halfLabel = Math.floor(labelHeight / 2);
    assert.ok(
      nudgeSteps >= 2 && nudgePx > halfLabel + 1,
      'constants leave a second slot whose clip is strictly smaller'
    );
    // Aim at the second slot below the midpoint. Tile a column of nodes over
    // the label so every slot overlaps, leaving one gap that clips only that
    // slot: it starts mid-label and ends before the next slot begins.
    const slotOffset = 2 * nudgePx;
    const top = free.rect.y + slotOffset;
    const gapStart = top + halfLabel;
    const gapEnd = top + nudgePx - 1;
    // Rows of the target label covered by the tiles, vs a fully blocked slot.
    const clippedRows = halfLabel + Math.max(0, labelHeight - nudgePx + 1);
    assert.ok(clippedRows < labelHeight, 'the targeted slot is strictly less clipped');
    const tiles = Math.ceil((nudgeSteps * nudgePx + labelHeight) / nodeHeight) + 2;
    const places: Record<string, { x: number; y: number }> = { ...ends };
    const x = free.rect.x - 10;
    for (let k = 0; k < tiles; k++) {
      places[`above${k}`] = { x, y: gapStart - nodeHeight * (k + 1) };
      places[`below${k}`] = { x, y: gapEnd + nodeHeight * k };
    }
    const { items } = planEdges({ places, width: 900, height: 400 }, edges);
    const placed = items[0]!;
    assert.equal(placed.geometry.ly, baseLy + slotOffset, 'the partly clipped slot wins');
    const blockers = Object.entries(places).filter(([name]) => name !== 'a' && name !== 'b');
    const touched = blockers.some(
      ([, at]) =>
        placed.rect.x < at.x + nodeWidth &&
        at.x < placed.rect.x + placed.rect.width &&
        placed.rect.y < at.y + nodeHeight &&
        at.y < placed.rect.y + placed.rect.height
    );
    assert.ok(touched, 'best effort: the chosen slot still overlaps a node');
  });
});
