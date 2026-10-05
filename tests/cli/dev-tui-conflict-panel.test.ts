// The busy-port panel `dev` prints on the human TTY path
// (src/cli/dev-tui/conflict-panel.ts): the same `dev:` lines inside a rounded
// box whose border is a dim yellow, plain with NO_COLOR. Pure string
// rendering; dev.ts decides when it prints.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatPlanFailure,
  renderConflictPanel,
  shouldFramePortConflict,
} from '../../src/cli/dev-tui/conflict-panel.js';

const ESC = String.fromCharCode(0x1b);
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (text: string): string => text.replace(SGR_PATTERN, '');

const LINES = [
  'dev: port 8081 declared by host is already busy',
  'dev: free the port(s), pass --port for the host, or use --auto-ports to reassign busy ports',
];

describe('renderConflictPanel', () => {
  it('hugs the widest line inside a rounded box with one space of left padding', () => {
    const panel = renderConflictPanel(['dev: a', 'dev: bcd'], { columns: 80, color: false });
    assert.equal(
      panel,
      ['╭─────────╮', '│ dev: a  │', '│ dev: bcd│', '╰─────────╯'].join('\n')
    );
  });

  it('keeps every line verbatim, dev: prefix included, when it fits', () => {
    const panel = renderConflictPanel(LINES, { columns: 120, color: false });
    const rows = panel.split('\n');
    assert.equal(rows.length, LINES.length + 2);
    assert.equal(rows[1], `│ ${LINES[0]!.padEnd(LINES[1]!.length)}│`);
    assert.equal(rows[2], `│ ${LINES[1]}│`);
  });

  it('caps the box at the terminal width and word-wraps what does not fit', () => {
    const panel = renderConflictPanel(LINES, { columns: 40, color: false });
    const rows = panel.split('\n');
    for (const row of rows) {
      assert.equal([...row].length, 40, `every row is exactly the cap: ${row}`);
    }
    // Words survive whole: the wrapped text reads back as the original lines.
    const text = rows
      .slice(1, -1)
      .map((row) => row.slice(2, -1).trimEnd())
      .join(' ');
    assert.equal(text, LINES.join(' '));
  });

  it('hard-breaks a single word longer than the box', () => {
    const panel = renderConflictPanel([`dev: ${'x'.repeat(30)}`], { columns: 20, color: false });
    const rows = panel.split('\n');
    for (const row of rows) assert.equal([...row].length, 20);
    assert.equal(
      rows.slice(1, -1).map((row) => row.slice(2, -1).trimEnd()).join(''),
      `dev:${'x'.repeat(30)}`
    );
  });

  it('paints only the border, dim yellow, leaving the text default', () => {
    const panel = renderConflictPanel(['dev: a'], { columns: 80, color: true });
    const rows = panel.split('\n');
    const border = (text: string): string => `${ESC}[2;33m${text}${ESC}[0m`;
    assert.equal(rows[0], border('╭───────╮'));
    assert.equal(rows[1], `${border('│')} dev: a${border('│')}`);
    assert.equal(rows[2], border('╰───────╯'));
    assert.equal(strip(panel), renderConflictPanel(['dev: a'], { columns: 80, color: false }));
  });

  it('emits zero escape bytes without color', () => {
    assert.ok(!renderConflictPanel(LINES, { columns: 60, color: false }).includes(ESC));
  });
});

// dev.ts writes a failed plan through these two: the gate decides whether the
// human TTY path frames a port conflict, the formatter turns the plan's
// reasons into the exact writeErr payloads.
describe('shouldFramePortConflict', () => {
  it('frames only a port conflict on the TUI path with stderr at a TTY', () => {
    assert.equal(
      shouldFramePortConflict({ tuiCondition: true, portConflict: true, stderrIsTTY: true }),
      true
    );
  });

  it('keeps bare lines when stderr is not a TTY (2> file)', () => {
    assert.equal(
      shouldFramePortConflict({ tuiCondition: true, portConflict: true, stderrIsTTY: false }),
      false
    );
  });

  it('keeps bare lines off the TUI path or for non-port failures', () => {
    assert.equal(
      shouldFramePortConflict({ tuiCondition: false, portConflict: true, stderrIsTTY: true }),
      false
    );
    assert.equal(
      shouldFramePortConflict({ tuiCondition: true, portConflict: false, stderrIsTTY: true }),
      false
    );
  });
});

describe('formatPlanFailure', () => {
  const REASONS = [
    'port 8081 declared by host is already busy',
    'free the port(s), pass --port for the host, or use --auto-ports to reassign busy ports',
  ];

  it('is byte-identical to the old `dev: ${reason}` lines when not framed', () => {
    assert.deepEqual(
      formatPlanFailure(REASONS, { framed: false, columns: 80, color: true }),
      REASONS.map((reason) => `dev: ${reason}`)
    );
  });

  it('keeps non-port reasons bare, one write per reason', () => {
    const reasons = ['no host app found', 'workspace config is invalid'];
    assert.deepEqual(
      formatPlanFailure(reasons, { framed: false, columns: 80, color: false }),
      ['dev: no host app found', 'dev: workspace config is invalid']
    );
  });

  it('frames the prefixed lines in one panel write when framed', () => {
    const options = { columns: 120, color: true };
    assert.deepEqual(formatPlanFailure(REASONS, { framed: true, ...options }), [
      renderConflictPanel(
        REASONS.map((reason) => `dev: ${reason}`),
        options
      ),
    ]);
  });
});
