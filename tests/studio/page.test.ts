// Static guards on the Studio page string (docs/PRD.md §7.2/§7.3).
//
// These are the rules that cannot be verified by rendering: the page must not
// contain the mechanisms that break them (external loads, innerHTML). The
// behavioral proof lives in tests/e2e/studio.spec.ts; this file is the cheap
// regression net that fires even when Playwright cannot run.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
