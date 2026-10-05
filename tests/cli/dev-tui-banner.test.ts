// G4 startup banner: pure-function contract for `renderStartupBanner`
// (src/cli/dev-tui/banner.ts). No terminal, no process — the SAME string a
// human sees, asserted as data: centering math, suppression rules, the
// color/no-color split, and the Ghostty-safe charset (printable ASCII +
// braille + box drawing; nothing else renders reliably across terminals).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BANNER_MIN_COLUMNS,
  colorAllowed,
  renderStartupBanner,
} from '../../src/cli/dev-tui/banner.js';
import { repoRoot } from './run-bin.js';

// Printable ASCII (space..~) plus the two Unicode ranges the drawing is
// allowed to use. Anything outside this set is a rendering liability.
const SAFE_CHARS = /^[\x20-\x7E\u2800-\u28FF\u2500-\u257F]*$/;
// SGR stripper: no-control-regex bans an ESC literal in a pattern, so the
// byte is spliced in at runtime (same idiom as app.tsx's mouse regexes).
const ESC = String.fromCharCode(0x1b);
const SGR_SEQUENCE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

describe('startup banner', () => {
  it('drops the art below the minimum columns and keeps the text lines', () => {
    const full = renderStartupBanner({ version: '1.2.3', columns: BANNER_MIN_COLUMNS, color: false });
    assert.match(full, /[\u2800-\u28FF]/);
    const compact = renderStartupBanner({ version: '1.2.3', columns: BANNER_MIN_COLUMNS - 1, color: false });
    const rows = compact.split('\n');
    assert.equal(rows.length, 2, compact);
    assert.doesNotMatch(compact, /[\u2800-\u28FF]/);
    assert.match(rows[0] ?? '', /repack-atlas v1\.2\.3/);
    assert.match(rows[1] ?? '', /module federation, made visible/);
    for (const row of rows) assert.ok(row.length <= BANNER_MIN_COLUMNS - 1, row);
  });

  it('prints nothing when even the text lines would wrap', () => {
    const tagline = 'module federation, made visible'.length;
    assert.notEqual(renderStartupBanner({ version: '1.2.3', columns: tagline, color: false }), '');
    assert.equal(renderStartupBanner({ version: '1.2.3', columns: tagline - 1, color: true }), '');
    assert.equal(renderStartupBanner({ version: '1.2.3', columns: 10, color: false }), '');
    assert.equal(renderStartupBanner({ version: '1.2.3', columns: Number.NaN, color: false }), '');
  });

  it('color=false yields zero escape bytes', () => {
    const plain = renderStartupBanner({ version: '1.2.3', columns: 80, color: false });
    assert.ok(plain.length > 0);
    assert.ok(!plain.includes('\u001b'), 'plain banner must carry no SGR bytes');
  });

  it('color=true wraps lines in SGR codes and resets each of them', () => {
    const colored = renderStartupBanner({ version: '1.2.3', columns: 80, color: true });
    assert.ok(colored.includes('\u001b['));
    assert.ok(colored.includes('\u001b[0m'), 'every painted line must reset');
    // Stripping SGR sequences yields the plain layout byte-for-byte.
    const stripped = colored.replace(SGR_SEQUENCE, '');
    assert.equal(stripped, renderStartupBanner({ version: '1.2.3', columns: 80, color: false }));
  });

  it('carries the wordmark, the version, and the tagline', () => {
    const banner = renderStartupBanner({ version: '0.9.1', columns: 80, color: false });
    assert.match(banner, /repack-atlas v0\.9\.1/);
    assert.match(banner, /module federation, made visible/);
    // No version available (readVersion failed upstream): the line degrades,
    // it never renders `vundefined`.
    const noVersion = renderStartupBanner({ columns: 80, color: false });
    assert.match(noVersion, /^\s*repack-atlas\s*$/m);
    assert.ok(!noVersion.includes('vundefined'));
    assert.ok(!noVersion.includes('undefined'));
  });

  it('fits the row budget (24-row balloon art plus title plus tagline)', () => {
    const lines = renderStartupBanner({ version: '1.0.0', columns: 80, color: false }).split('\n');
    // The user-supplied balloon artwork is 24 rows verbatim; the banner adds
    // exactly the wordmark and the tagline. A redraw that changes this
    // budget must be a deliberate, user-blessed decision, not drift.
    assert.equal(lines.length, 26, `banner is ${lines.length} rows`);
  });

  it('uses only Ghostty-safe characters', () => {
    const plain = renderStartupBanner({ version: '1.0.0', columns: 80, color: false });
    for (const line of plain.split('\n')) {
      const bad = [...line].filter((c) => !SAFE_CHARS.test(c));
      assert.deepEqual(bad, [], `unsafe chars in line: ${JSON.stringify(line)}`);
    }
    // The art is braille-led (the dotted-sphere visual language), so the
    // braille range must actually be exercised.
    assert.match(plain, /[\u2800-\u28FF]/);
  });

  it('centers the block against the columns it was given', () => {
    const columns = 90;
    const lines = renderStartupBanner({ version: '1.0.0', columns, color: false }).split('\n');
    const indentOf = (line: string): number => line.length - line.trimStart().length;
    // Content width excludes the block indent and the lines' own design
    // spaces: the widest real content (the tagline) defines the block.
    const contentWidth = Math.max(
      ...lines.map((l) => l.trimEnd().length - indentOf(l))
    );
    // Block-level centering: floor((columns - widest content) / 2) leading
    // spaces at the block edge; art rows may add their own inner offset, so
    // the block indent is the MINIMUM over the lines.
    const base = Math.min(...lines.map(indentOf));
    assert.equal(base, Math.floor((columns - contentWidth) / 2));
    // The title and tagline sit exactly at the block edge.
    const title = lines.find((l) => l.includes('repack-atlas')) ?? '';
    assert.equal(indentOf(title), base);
    // Wider terminal pushes the block right, never left of zero.
    const wide = renderStartupBanner({ version: '1.0.0', columns: 120, color: false }).split('\n');
    assert.ok(Math.min(...wide.map(indentOf)) > base, 'more columns must indent more');
  });


  it('banner.ts stays pure like model.ts: no io, no ink/react, no fs', () => {
    const source = readFileSync(
      path.join(repoRoot, 'src', 'cli', 'dev-tui', 'banner.ts'),
      'utf8'
    );
    assert.doesNotMatch(source, /^\s*import\b[^;]*from\s+/m, 'the banner must not import anything');
    assert.doesNotMatch(source, /\bimport\(/, 'no dynamic imports either');
    assert.doesNotMatch(source, /\bprocess\.(stdout|stderr|env|exit)/);
    assert.doesNotMatch(source, /\bconsole\./);
  });
});

// no-color.org: NO_COLOR disables color only when it is present AND
// non-empty. One helper shared by the banner, the wizard and the conflict
// panel, so the three sites cannot drift.
describe('colorAllowed', () => {
  it('allows color when NO_COLOR is unset', () => {
    assert.equal(colorAllowed({}), true);
  });

  it('allows color when NO_COLOR is set but empty', () => {
    assert.equal(colorAllowed({ NO_COLOR: '' }), true);
  });

  it('disables color for any non-empty NO_COLOR value', () => {
    assert.equal(colorAllowed({ NO_COLOR: '1' }), false);
    assert.equal(colorAllowed({ NO_COLOR: '0' }), false);
    assert.equal(colorAllowed({ NO_COLOR: 'false' }), false);
  });
});
