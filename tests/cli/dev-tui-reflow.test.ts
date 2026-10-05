// Row math behind the wizard's resize compensation (src/cli/dev-tui/reflow.ts).
// On a width decrease the terminal re-wraps every line wider than the new
// width before ink erases its frame; these helpers count the rows that frame
// now occupies and build the escape sequence that deletes the extra ones ink
// cannot see. Pure string math: no terminal involved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  reflowCompensation,
  reflowedRows,
  safestReflowCompensation,
  terminalReflowsOnResize,
} from '../../src/cli/dev-tui/reflow.js';

const ESC = String.fromCharCode(0x1b);

describe('reflowedRows', () => {
  it('counts one row per line that still fits', () => {
    assert.equal(reflowedRows('abc\ndef', 10), 2);
  });

  it('counts the rows a too-wide line wraps into', () => {
    // 25 visible columns at 10 → 3 rows; the short line stays 1.
    assert.equal(reflowedRows(`${'x'.repeat(25)}\nok`, 10), 4);
    // Exactly the width does not wrap.
    assert.equal(reflowedRows('x'.repeat(10), 10), 1);
  });

  it('keeps an empty line as one row', () => {
    assert.equal(reflowedRows('a\n\nb', 10), 3);
  });

  it('drops the trailing empty segment of a frame ending in a newline', () => {
    assert.equal(reflowedRows('a\nb\n', 10), 2);
  });

  it('ignores SGR bytes when measuring', () => {
    const painted = `${ESC}[2m${'y'.repeat(10)}${ESC}[0m`;
    assert.equal(reflowedRows(painted, 10), 1);
    assert.equal(reflowedRows(painted, 5), 2);
  });

  it('measures the box-drawing glyphs as one column each', () => {
    assert.equal(reflowedRows(`╭${'─'.repeat(18)}╮`, 10), 2);
  });

  it('is zero for an empty frame', () => {
    assert.equal(reflowedRows('', 10), 0);
  });
});

describe('reflowCompensation', () => {
  it('is empty when nothing wrapped', () => {
    assert.equal(reflowCompensation('abc\ndef', 10, 40), '');
  });

  it('deletes the extra rows above the part ink erases and returns to the cursor row', () => {
    // 3 lines: 25 cols (3 rows), 25 cols (3 rows), 1 col → R = 7, F = 3.
    const frame = `${'x'.repeat(25)}\n${'x'.repeat(25)}\nz`;
    assert.equal(
      reflowCompensation(frame, 10, 40),
      `\r${ESC}[7A${ESC}[4M${ESC}[3B`
    );
  });

  it('caps the climb at the screen height minus the cursor row', () => {
    // R = 30 rows but the screen has 12: only 11 rows exist above the cursor.
    const frame = `${'x'.repeat(100)}\n${'x'.repeat(100)}\n${'x'.repeat(100)}`;
    assert.equal(
      reflowCompensation(frame, 10, 12),
      `\r${ESC}[11A${ESC}[8M${ESC}[3B`
    );
  });

  it('is empty when the capped climb leaves nothing beyond the frame', () => {
    const frame = `${'x'.repeat(100)}\n${'x'.repeat(100)}\n${'x'.repeat(100)}`;
    assert.equal(reflowCompensation(frame, 10, 4), '');
  });

  it('is empty for an empty frame', () => {
    assert.equal(reflowCompensation('', 10, 40), '');
  });

  // wizard.tsx passes `stdout.rows` / `stdout.columns` unchecked: a stream
  // that reports no size yields undefined (NaN in the math) or 0.
  it('is empty when the screen height is unknown, zero or infinite', () => {
    const frame = 'x'.repeat(100);
    assert.equal(reflowCompensation(frame, 10, undefined as unknown as number), '');
    assert.equal(reflowCompensation(frame, 10, Number.NaN), '');
    assert.equal(reflowCompensation(frame, 10, 0), '');
    assert.equal(reflowCompensation(frame, 10, Number.POSITIVE_INFINITY), '');
  });

  it('is empty when the new width is unknown, zero or infinite', () => {
    const frame = 'x'.repeat(100);
    assert.equal(reflowCompensation(frame, undefined as unknown as number, 40), '');
    assert.equal(reflowCompensation(frame, 0, 40), '');
    assert.equal(reflowCompensation(frame, Number.POSITIVE_INFINITY, 40), '');
  });
});

describe('reflowedRows with an unusable width', () => {
  it('counts one row per line instead of NaN', () => {
    const frame = `${'x'.repeat(100)}\nok`;
    assert.equal(reflowedRows(frame, Number.NaN), 2);
    assert.equal(reflowedRows(frame, undefined as unknown as number), 2);
    assert.equal(reflowedRows(frame, 0), 2);
    assert.equal(reflowedRows(frame, -5), 2);
    assert.equal(reflowedRows(frame, Number.POSITIVE_INFINITY), 2);
  });
});

describe('safestReflowCompensation', () => {
  // ink's throttled draw may lag its last commit by one frame, so the port
  // hands over the last TWO committed frames and the helper deletes for the
  // one that wrapped into FEWER extra rows: a ghost row beats a lost one.
  const small = `${'x'.repeat(25)}\nz`; // R = 4, F = 2 → 2 extra
  const big = `${'x'.repeat(25)}\n${'x'.repeat(25)}\nz`; // R = 7, F = 3 → 4 extra

  it('picks the frame with fewer extra rows, in either order', () => {
    const expected = reflowCompensation(small, 10, 40);
    assert.equal(expected, `\r${ESC}[4A${ESC}[2M${ESC}[2B`);
    assert.equal(safestReflowCompensation([small, big], 10, 40), expected);
    assert.equal(safestReflowCompensation([big, small], 10, 40), expected);
  });

  it('deletes nothing when either frame needs nothing', () => {
    assert.equal(safestReflowCompensation([big, 'abc'], 10, 40), '');
    assert.equal(safestReflowCompensation(['abc', big], 10, 40), '');
  });

  it('deletes nothing without a committed frame', () => {
    assert.equal(safestReflowCompensation([], 10, 40), '');
  });

  it('matches reflowCompensation for a single frame', () => {
    assert.equal(
      safestReflowCompensation([big], 10, 40),
      reflowCompensation(big, 10, 40)
    );
  });
});

describe('terminalReflowsOnResize', () => {
  // Conservative allowlist: only emulators known to re-wrap the screen on a
  // width change get the delete-lines compensation; anywhere else a leftover
  // ghost border is the safe failure, deleting real rows is not.
  const yes: NodeJS.ProcessEnv[] = [
    { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' },
    { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' },
    { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' },
    { TERM: 'xterm-ghostty' },
    { GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources/ghostty' },
    { TERM_PROGRAM: 'WezTerm' },
    { TERM: 'wezterm' },
    { WEZTERM_PANE: '0' },
    { TERM_PROGRAM: 'vscode' },
    { TERM_PROGRAM: 'Tabby' },
    { TERM_PROGRAM: 'Hyper' },
    { TERM: 'xterm-kitty' },
    { KITTY_WINDOW_ID: '1', TERM: 'xterm-256color' },
    { TERM: 'alacritty' },
    { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color' },
  ];
  const no: NodeJS.ProcessEnv[] = [
    {},
    { TERM: 'xterm' },
    { TERM: 'xterm-256color' },
    { TERM: 'linux' },
    { TERM: 'dumb' },
    { TERM: 'screen-256color' },
    { TERM: 'tmux-256color' },
    { TERM_PROGRAM: 'SomethingElse' },
    { TERM_PROGRAM: 'iterm.app' }, // exact names only
    { TERM_PROGRAM: '', TERM: '' },
    { KITTY_WINDOW_ID: '' }, // an empty marker is not a marker
    // GNU screen owns the grid even inside a reflowing emulator.
    { STY: '123.pts-0.host', TERM: 'screen', KITTY_WINDOW_ID: '1' },
    { STY: '123.pts-0.host', TERM_PROGRAM: 'iTerm.app' },
  ];

  for (const env of yes) {
    it(`reflows: ${JSON.stringify(env)}`, () => {
      assert.equal(terminalReflowsOnResize(env), true);
    });
  }
  for (const env of no) {
    it(`does not reflow: ${JSON.stringify(env)}`, () => {
      assert.equal(terminalReflowsOnResize(env), false);
    });
  }
});
