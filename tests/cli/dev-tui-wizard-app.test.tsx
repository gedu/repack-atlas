/** @jsxImportSource react */
// Render smoke for the ink wizard view (G5, `WizardApp` in
// src/cli/dev-tui/wizard.tsx). The state machine is fully covered without a
// terminal by dev-tui-wizard.test.ts and the port's terminal hygiene by
// dev-tui-wizard-port.test.ts; what this file proves is the last mile — that
// the view actually paints the controller's state and repaints when it moves,
// through the same ink-testing-library harness dev-tui-app.test.tsx uses.
//
// Like the dashboard tests, colors are asserted through the GLYPHS the palette
// decorates: ink-testing-library's stdout is not a TTY, so chalk strips every
// SGR code and no frame can prove a color. The color/no-color split that IS
// observable lives at the port's direct-write path (dev-tui-wizard-port.test.ts
// locks the SGR bytes there).

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { cleanup, render } from 'ink-testing-library';
import {
  CHECKED,
  CURSOR_GLYPH,
  DONE_GLYPH,
  INPUT_CARET,
  PROMPT_GLYPH,
  UNCHECKED,
  WizardApp,
} from '../../src/cli/dev-tui/wizard.js';
import {
  createWizardController,
  type WizardController,
  type WizardRequest,
} from '../../src/cli/dev-tui/wizard-model.js';

// ink's `is-in-ci` mode (CI/CONTINUOUS_INTEGRATION set to anything but
// ''/0/false, as every CI runner does) skips per-frame writes and, on
// unmount, writes only `lastOutput + '\n'` — which ink never sets in its
// debug mode, so the post-unmount frame this file reads is empty there. Only
// that one teardown assertion is gated below; everything else in this file is
// plain per-frame content, written in both modes (ink-testing-library renders
// in ink's debug mode, whose writes happen before the CI branch).
const ciMode = ['CI', 'CONTINUOUS_INTEGRATION'].some(
  (key) => key in process.env && process.env[key] !== '0' && process.env[key] !== 'false'
);

const wait = (ms = 60): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Glyphs are data, not patterns: `[ ]`/`[x]` must be escaped to match text. */
const re = (pattern: string): RegExp =>
  new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const REMOTES: WizardRequest = {
  kind: 'multiselect',
  message: 'Which remotes to run?',
  options: [
    { value: 'mini_auth', label: 'mini_auth' },
    { value: 'mini_store', label: 'mini_store' },
  ],
  initialValues: ['mini_auth', 'mini_store'],
  emptyHint: 'host only',
};

const PLATFORM: WizardRequest = {
  kind: 'select',
  message: 'Which app platform are you running?',
  options: [
    { value: 'ios', label: 'iOS' },
    { value: 'android', label: 'Android' },
    { value: 'all', label: 'All / decide later' },
  ],
  initialValue: 'ios',
};

describe('dev tui wizard view', () => {
  // Ink instances hold their stdin listeners until the library-wide cleanup
  // runs; per-test unmount + one final sweep keep the suite from hanging on a
  // leaked session (same reason dev-tui-app.test.tsx ends with cleanup()).
  after(() => cleanup());

  it('renders the live multiselect with the focus bar, boxes and help line', () => {
    const controller = createWizardController();
    void controller.ask(REMOTES);
    const app = render(<WizardApp controller={controller} color />);
    const frame = app.lastFrame() ?? '';
    assert.match(frame, new RegExp(PROMPT_GLYPH));
    assert.match(frame, /Which remotes to run\?/);
    // Focused row carries the roster's selection bar; both boxes are ticked by
    // the preselection.
    assert.match(frame, re(`${CURSOR_GLYPH}${CHECKED} mini_auth`));
    assert.match(frame, re(` ${CHECKED} mini_store`));
    assert.doesNotMatch(frame, re(UNCHECKED));
    assert.match(frame, /space toggle/);
    assert.match(frame, /clear all for host only/);
    app.unmount();
    app.cleanup();
  });

  it('repaints when the controller moves and prints a settled recap', async () => {
    const controller = createWizardController();
    const app = render(<WizardApp controller={controller} color />);
    assert.equal(
      (app.lastFrame() ?? '').trim(),
      '',
      'no question, no block'
    );

    const answer = controller.ask(REMOTES);
    await wait();
    assert.match(app.lastFrame() ?? '', /Which remotes to run\?/);

    controller.handleKey(' ', {}); // untick the focused remote
    await wait();
    assert.match(
      app.lastFrame() ?? '',
      re(`${CURSOR_GLYPH}${UNCHECKED} mini_auth`)
    );

    controller.handleKey('', { return: true });
    assert.deepEqual(await answer, { status: 'ok', value: ['mini_store'] });
    await wait();
    const settled = app.lastFrame() ?? '';
    assert.match(settled, re(`${DONE_GLYPH} Which remotes to run?`));
    assert.match(settled, /mini_store/, 'the recap names what was answered');
    assert.doesNotMatch(
      settled,
      /space toggle/,
      'the answered question stops being live'
    );
    app.unmount();
    app.cleanup();
  });

  it('shows the error line while a rejected answer stays open', async () => {
    const controller = createWizardController();
    const app = render(<WizardApp controller={controller} color />);
    const answer = controller.ask({
      kind: 'text',
      message: 'Port for Atlas Host:',
      validate: (value: string): string | undefined =>
        /^\d+$/.test(value) ? undefined : 'Enter an integer port between 1 and 65535.',
    });
    await wait();
    // The empty draft renders the caret alone (ink trims the line's trailing
    // space), so match the caret itself.
    assert.match(app.lastFrame() ?? '', re(INPUT_CARET.trimEnd()));
    controller.handleKey('nope', {});
    await wait();
    assert.match(app.lastFrame() ?? '', /› nope/, 'the draft is visible');
    controller.handleKey('', { return: true });
    await wait();
    assert.match(
      app.lastFrame() ?? '',
      /Enter an integer port between 1 and 65535\./
    );
    assert.match(app.lastFrame() ?? '', /› nope/, 'what was typed stays on screen');
    // Typing again clears the error; the draft itself survives the rejection
    // (so the human edits, not retypes) — clear it before the fix lands.
    controller.handleKey(' ', {});
    await wait();
    assert.doesNotMatch(
      app.lastFrame() ?? '',
      /integer port/,
      'typing again clears the stale error'
    );
    for (const _ of [0, 1, 2, 3, 4]) {
      controller.handleKey('', { backspace: true });
    }
    controller.handleKey('9001', {});
    await wait();
    assert.match(app.lastFrame() ?? '', /› 9001/);
    controller.handleKey('', { return: true });
    assert.deepEqual(await answer, { status: 'ok', value: '9001' });
    app.unmount();
    app.cleanup();
  });

  it('renders a select with its preselection focused and a confirm with its pair', async () => {
    const controller = createWizardController();
    const app = render(<WizardApp controller={controller} color />);
    const platform = controller.ask(PLATFORM);
    await wait();
    assert.match(app.lastFrame() ?? '', /▍iOS/, 'the initialValue is focused');
    assert.match(app.lastFrame() ?? '', /All \/ decide later/);
    controller.handleKey('', { return: true });
    assert.deepEqual(await platform, { status: 'ok', value: 'ios' });

    const confirm = controller.ask({
      kind: 'confirm',
      message: 'Launch the app on ios when the host is ready?',
      initialValue: false,
    });
    await wait();
    const frame = app.lastFrame() ?? '';
    assert.match(frame, /Launch the app on ios when the host is ready\?/);
    assert.match(frame, /yes/, 'both answers are drawn');
    assert.match(frame, /no/);
    // One indent column (the same gutter the option rows use), then the pair.
    assert.match(frame, /^ yes {2}no$/m, 'the live pair is one plain row');
    controller.handleKey('y', {});
    assert.deepEqual(await confirm, { status: 'ok', value: true });
    app.unmount();
    app.cleanup();
  });

  it('keeps notes and the walk-away line on screen with the recaps', async () => {
    const controller = createWizardController();
    const app = render(<WizardApp controller={controller} color />);
    controller.note('Launch skipped: launching the app needs a single platform.');
    await wait();
    assert.match(
      app.lastFrame() ?? '',
      /Launch skipped: launching the app needs a single platform\./
    );
    controller.cancelLine('Session cancelled.');
    await wait();
    assert.match(app.lastFrame() ?? '', /Session cancelled\./);
    app.unmount();
    app.cleanup();
  });

  // The recap panel (the #58 follow-up, D2). The settled answers are a
  // SUMMARY, not just scrollback: they render inside a dim rounded box — the
  // dashboard's own border idiom — separated from the live question by a
  // blank line, and the box stays on screen after the wizard closes so the
  // `dev:` lines that follow are visually split from it (measured: ink's
  // unmount leaves the final frame standing, same as <Static> did).
  it('frames the settled recap block and separates it from the live question', async () => {
    const controller = createWizardController();
    const app = render(<WizardApp controller={controller} color />);
    const answer = controller.ask(REMOTES);
    await wait();
    controller.handleKey('', { return: true });
    assert.deepEqual(await answer, { status: 'ok', value: ['mini_auth', 'mini_store'] });
    // A second question keeps something LIVE below the panel, which is what
    // the vertical separation is measured against.
    void controller.ask(PLATFORM);
    await wait();
    const frame = app.lastFrame() ?? '';
    const lines = frame.split('\n');
    assert.match(frame, /╭.*╮/, 'the recap block is a box');
    assert.match(frame, /╰.*╯/, 'the box closes');
    const top = lines.findIndex((l) => l.startsWith('╭'));
    const bottom = lines.findIndex((l) => l.startsWith('╰'));
    const recap = lines.findIndex((l) => l.includes(`✓ Which remotes to run?`));
    const live = lines.findIndex((l) => l.includes(PROMPT_GLYPH));
    assert.ok(top >= 0 && recap > top, 'the recap is INSIDE the box');
    assert.ok(bottom > recap, 'the box closes after the recap');
    assert.ok(live > bottom, 'the live question is outside the box');
    assert.equal(
      (lines[bottom + 1] ?? 'x').trim(),
      '',
      'a blank line separates the box from the live question'
    );
    app.unmount();
    app.cleanup();
  });

  it('leaves the panel standing in the last frame ink emits on close', async () => {
    // What the human sees when the wizard ends on a port conflict: the recap
    // panel, then the `dev:` error lines the CLI writes after the prompt port
    // closed. This fake frame stream (ink-testing-library renders in ink's
    // debug mode, where every write carries the full screen) can prove the
    // half that matters INK controls: closing the wizard does not erase the
    // panel. That the `dev:` lines land below it is ordinary stdout ordering,
    // and the real-terminal look stays user-owned.
    const controller = createWizardController();
    const app = render(<WizardApp controller={controller} color />);
    const answer = controller.ask(REMOTES);
    await wait();
    controller.handleKey('', { return: true });
    assert.deepEqual(await answer, {
      status: 'ok',
      value: ['mini_auth', 'mini_store'],
    });
    await wait();
    const whileOpen = app.lastFrame() ?? '';
    app.unmount();
    await wait();
    const afterClose = app.lastFrame() ?? '';
    assert.match(whileOpen, /╭/, 'the panel was on screen while the wizard ran');
    if (!ciMode) {
      assert.match(
        afterClose,
        /╭[\s\S]*✓ Which remotes to run\?/,
        'the panel and its recap survive the wizard closing'
      );
      // Real-PTY check (2026-10-02): when the last question settled, the only
      // blank line was the question's gap and it vanished with the question —
      // the `dev:` error lines landed flush under the box bottom. The panel
      // must own its trailing blank line so what follows stays separated.
      const closedLines = afterClose.split('\n');
      const bottom = closedLines.findIndex((l) => l.startsWith('╰'));
      assert.ok(bottom >= 0, 'the box closed line is in the final frame');
      assert.equal(
        (closedLines[bottom + 1] ?? 'x').trim(),
        '',
        'a blank line follows the panel even with no live question, so the dev: lines that come after land one row below the box'
      );
    }
    app.cleanup();
  });

  it('renders the same content with color off (the palette is styling only)', async () => {
    const colored = createWizardController();
    const plain = createWizardController();
    void colored.ask(REMOTES);
    void plain.ask(REMOTES);
    const a = render(<WizardApp controller={colored} color />);
    const b = render(<WizardApp controller={plain} color={false} />);
    await wait();
    // ink-testing-library strips SGR on a non-TTY stdout, so the frames must be
    // identical: color can add styling, never content.
    assert.equal(a.lastFrame(), b.lastFrame());
    a.unmount();
    a.cleanup();
    b.unmount();
    b.cleanup();
  });

  it('routes real keystrokes through useInput into the controller', async () => {
    const controller = createWizardController();
    const app = render(<WizardApp controller={controller} color />);
    const answer = controller.ask(REMOTES);
    await wait();
    app.stdin.write(' '); // space unticks the focused option
    await wait();
    app.stdin.write('j'); // vim key moves the focus
    await wait();
    assert.match(app.lastFrame() ?? '', /▍\[x\] mini_store/);
    app.stdin.write('\r'); // Enter settles
    await wait();
    assert.deepEqual(await answer, { status: 'ok', value: ['mini_store'] });
    app.unmount();
    app.cleanup();
  });

  it('cancels the live question on Ctrl-C bytes', async () => {
    const controller: WizardController = createWizardController();
    const app = render(<WizardApp controller={controller} color={false} />);
    const answer = controller.ask(REMOTES);
    await wait();
    app.stdin.write('\u0003'); // ETX (raw-mode Ctrl-C)
    await wait();
    assert.deepEqual(await answer, { status: 'cancelled' });
    assert.equal(controller.quitting(), true);
    assert.match(app.lastFrame() ?? '', /cancelled/);
    app.unmount();
    app.cleanup();
  });
});
