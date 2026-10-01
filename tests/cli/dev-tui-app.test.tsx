/** @jsxImportSource react */
// Smoke tests for the ink dashboard (T3 + F1-F5 polish). The pure logic lives
// in the model suite (logWindow, partitionPinned, renderProgressFrame); these
// prove the component TREE renders the model and reacts to keys and wheel
// reports — via ink-testing-library, whose mock stdout strips colors
// (non-TTY), so assertions match plain text. `render` here is the test
// helper, not ink's. Colors (F5) are asserted through the GLYPH each level
// symbolizes; the palette itself is a pure-function contract (lineColor,
// symbolColor) checked without a terminal.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanup, render } from 'ink-testing-library';
import {
  animateLiveDots,
  DevTuiApp,
  isMouseOnlyInput,
  parseWheelEvents,
  splitLeadingSymbol,
  stripSpinner,
  truncate,
} from '../../src/cli/dev-tui/app.js';
import { createDevTuiModel } from '../../src/cli/dev-tui/model.js';

function seededModel(options: { ringCap?: number } = {}) {
  const model = createDevTuiModel({
    apps: [
      { key: 'host', name: 'Atlas Host', role: 'host', port: 8081 },
      {
        key: 'online-store',
        name: 'online-store',
        role: 'remote',
        port: 8082,
      },
    ],
    launchName: 'launch',
    ...(options.ringCap === undefined ? {} : { ringCap: options.ringCap }),
  });
  model.status('host', 'ready', 8081, 111);
  model.status('online-store', 'bundling', 8082, 222);
  model.oneShot('launch', { status: 'exited', code: 0, signal: null });
  model.log('host', 'stdout', 'info: [webpack-cli] Compiler starting...');
  model.log('host', 'stderr', 'warning: deprecated flag');
  model.log('online-store', 'stdout', 'building the remote');
  return model;
}

const wait = (ms = 50): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('dev tui app', () => {
  it('renders the sidebar roster with glyphs and the selection marker', () => {
    const app = render(
      <DevTuiApp model={seededModel()} onQuit={() => undefined} />
    );
    const frame = app.lastFrame();
    assert.match(frame ?? '', /Atlas Host/);
    assert.match(frame ?? '', /online-store/);
    assert.match(frame ?? '', /✓/); // host ready
    assert.match(frame ?? '', /●/); // remote bundling
    assert.match(frame ?? '', /→/); // one-shot exited
    assert.match(frame ?? '', /▍✓ Atlas Host/); // selected first row
    // Port labels render next to the names.
    assert.match(frame ?? '', /8081/);
    // The panel header shows the selected app and its log.
    assert.match(frame ?? '', /info: \[webpack-cli\] Compiler starting/);
    // stderr lines carry the `!` marker.
    assert.match(frame ?? '', /! warning: deprecated flag/);
    app.unmount();
    app.cleanup();
  });

  it('divides the panes with a border, not a text gutter (F2)', () => {
    const app = render(
      <DevTuiApp model={seededModel()} onQuit={() => undefined} />
    );
    const frame = app.lastFrame() ?? '';
    // The divider is the bold right-border glyph; the old single-line `│`
    // text gutter is gone, so a log-pane drag cannot scoop it up.
    assert.match(frame, /┃/);
    assert.doesNotMatch(frame, /│/);
    app.unmount();
    app.cleanup();
  });

  it('shows the hidden-lines note once the ring cap dropped lines', () => {
    const model = createDevTuiModel({
      apps: [{ key: 'host', name: 'host', role: 'host', port: 8081 }],
      ringCap: 4,
    });
    for (let i = 1; i <= 6; i += 1) {
      model.log('host', 'stdout', `line ${i}`);
    }
    const app = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    const frame = app.lastFrame() ?? '';
    assert.match(frame, /… 2 earlier lines hidden/);
    // Tail-anchored: the newest line is visible, the first dropped one is not.
    assert.match(frame, /line 6/);
    assert.doesNotMatch(frame, /line 1\b/);
    app.unmount();
    app.cleanup();
  });

  it('moves selection with the down arrow and cycles with tab', async () => {
    const model = seededModel();
    const app = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    app.stdin.write('\u001B[B'); // down arrow
    await wait();
    assert.match(app.lastFrame() ?? '', /▍● online-store/);
    assert.match(app.lastFrame() ?? '', /building the remote/);
    // Tab from the last row wraps to the first.
    model.selectLast();
    await wait(150);
    app.stdin.write('\t');
    await wait();
    assert.equal(model.selectedIndex(), 0);
    app.unmount();
    app.cleanup();
  });

  it('routes q and Ctrl-C to onQuit without exiting the process', async () => {
    let quits = 0;
    const app = render(
      <DevTuiApp model={seededModel()} onQuit={() => (quits += 1)} />
    );
    app.stdin.write('q');
    app.stdin.write('\u0003'); // ETX (raw-mode Ctrl-C)
    await wait();
    assert.equal(quits, 2);
    app.unmount();
    app.cleanup();
  });

  it('hides the studio hint when onOpenStudio is absent', () => {
    const without = render(
      <DevTuiApp model={seededModel()} onQuit={() => undefined} />
    );
    assert.doesNotMatch(without.lastFrame() ?? '', /v studio/);
    const withStudio = render(
      <DevTuiApp
        model={seededModel()}
        onQuit={() => undefined}
        onOpenStudio={() => undefined}
      />
    );
    assert.match(withStudio.lastFrame() ?? '', /v studio/);
    without.unmount();
    withStudio.unmount();
    cleanup();
  });

  it('routes the wheel by column: panel scrolls, sidebar selects (F1)', async () => {
    const model = seededModel();
    for (let i = 1; i <= 40; i += 1) {
      model.log('host', 'stdout', `line ${i}`);
    }
    const app = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    await wait(150);
    assert.match(app.lastFrame() ?? '', /line 40/); // autoscroll at bottom
    // SGR wheel DOWN press+release over the panel (col 40 > sidebar width):
    // scrolls the log, selection untouched.
    app.stdin.write('\u001b[<65;40;3M\u001b[<65;40;3m');
    await wait(150);
    assert.equal(model.selectedIndex(), 0);
    // wheel UP over the sidebar (col 5): selection moves with clamping...
    app.stdin.write('\u001b[<65;5;2M\u001b[<65;5;2m');
    await wait(150);
    assert.equal(model.selectedIndex(), 1);
    app.stdin.write('\u001b[<64;5;2M\u001b[<64;5;2m');
    await wait(150);
    assert.equal(model.selectedIndex(), 0);
    // A plain click (button 0) inside the panel is swallowed, not a key:
    // it must not quit, select, or scroll.
    app.stdin.write('\u001b[<0;40;3M\u001b[<0;40;3m');
    await wait(150);
    assert.equal(model.selectedIndex(), 0);
    app.unmount();
    app.cleanup();
  });

  it('never leaks mouse-tracking escape bytes on a non-TTY stdout', () => {
    // The mouse-decseq writer is gated on stdout.isTTY; the mock stdout is
    // not a TTY, so captured frames must stay clean.
    const app = render(
      <DevTuiApp model={seededModel()} onQuit={() => undefined} />
    );
    assert.doesNotMatch(app.lastFrame() ?? '', /\[\?100[06][hl]/);
    app.unmount();
    app.cleanup();
  });

  it('pins the live progress bar as the panel bottom row (F4)', async () => {
    const model = createDevTuiModel({
      apps: [{ key: 'host', name: 'host', role: 'host', port: 8081 }],
    });
    model.status('host', 'bundling', 8081);
    model.log('host', 'stdout', 'info: start');
    model.log('host', 'stdout', 'transforming [===-------] 30%');
    model.log('host', 'stdout', 'transforming [========--] 93%');
    const app = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    await wait(150);
    const lines = (app.lastFrame() ?? '').split('\n');
    // The pinned bar sits on the LAST panel row, the help block's line
    // notwithstanding: it renders below every body line.
    assert.match(lines.at(-1) ?? '', /transforming \[█+\] 93%|\[========--\] 93%/);
    assert.ok(
      lines.findIndex((l) => /info: start/.test(l)) <
        lines.findIndex((l) => /93%/.test(l)),
      'body lines render above the pinned bar'
    );
    // Once Compiled lands and the bar stops being recent, it unpins and the
    // bar flows as normal history between the lines around it.
    model.log('host', 'stdout', '✔ Compiled in 4.2s');
    model.log('host', 'stdout', 'info: asset main.js 1.2 MiB');
    model.log('host', 'stdout', 'warning: entrypoint size limit');
    await wait(150);
    const after = (app.lastFrame() ?? '').split('\n');
    const barRow = after.findIndex((l) => /93%/.test(l));
    const compiledRow = after.findIndex((l) => /Compiled/.test(l));
    assert.ok(barRow >= 0 && compiledRow > barRow, 'bar flows as history');
    app.unmount();
    app.cleanup();
  });

  it('animates a live dotted spinner at render time (F3)', () => {
    const model = createDevTuiModel({
      apps: [{ key: 'host', name: 'host', role: 'host', port: 8081 }],
    });
    model.status('host', 'bundling', 8081);
    model.log('host', 'stdout', '- Building the app.......');
    const app = render(
      <DevTuiApp model={model} onQuit={() => undefined} frame={2} />
    );
    // frame 2 -> three dots; the model keeps the child's real last frame.
    assert.match(app.lastFrame() ?? '', /- Building the app\.\.\.\s*$/m);
    assert.equal(model.lines('host').at(-1)?.text, '- Building the app.......');
    app.unmount();
    app.cleanup();
  });

  it('renders the Re.Pack palette glyphs without doubling markers (F5)', () => {
    const model = createDevTuiModel({
      apps: [{ key: 'host', name: 'host', role: 'host', port: 8081 }],
    });
    model.log('host', 'stdout', 'warning: entrypoint size');
    model.log('host', 'stderr', '⚠ watch warning');
    model.log('host', 'stdout', '× something failed');
    const app = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    const frame = app.lastFrame() ?? '';
    // Auto-glyph for a level word with no symbol of its own.
    assert.match(frame, /⚠ warning: entrypoint size/);
    // stderr + child symbol: the symbol is kept ONCE, no `! ⚠` doubling.
    assert.match(frame, /⚠ watch warning/);
    assert.doesNotMatch(frame, /! ⚠/);
    // Error symbol stays in the line.
    assert.match(frame, /× something failed/);
    app.unmount();
    app.cleanup();
  });
});

describe('dev tui view helpers', () => {
  it('truncate keeps width and marks cuts', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.equal(truncate('hello world', 5), 'hell…');
    assert.equal(truncate('hello world', 5).length, 5);
    assert.equal(truncate('ab', 1), '…');
    assert.equal(truncate('ab', 0), '');
  });

  it('animateLiveDots cycles 1..6..1 and leaves dotless text alone (F3)', () => {
    assert.equal(animateLiveDots('- Building the app...', 0), '- Building the app.');
    assert.equal(animateLiveDots('- Building the app...', 5), '- Building the app......');
    assert.equal(animateLiveDots('- Building the app...', 6), '- Building the app.....');
    // Cycle length is 10 and the pattern grows then shrinks.
    const counts = Array.from({ length: 10 }, (_, frame) => {
      const out = animateLiveDots('x...', frame);
      return /\.+$/.exec(out)?.[0].length ?? 0;
    });
    assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 5, 4, 3, 2]);
    // Dotless text (bars, settled lines) is untouched.
    assert.equal(animateLiveDots('building [===---] 40%', 3), 'building [===---] 40%');
    assert.equal(animateLiveDots('plain', 3), 'plain');
  });

  it('splitLeadingSymbol separates Re.Pack level symbols from the message', () => {
    assert.deepEqual(splitLeadingSymbol('⚠ watch warning'), {
      indent: '',
      symbol: '⚠',
      rest: 'watch warning',
    });
    assert.deepEqual(splitLeadingSymbol('  × nested failure'), {
      indent: '  ',
      symbol: '×',
      rest: 'nested failure',
    });
    assert.deepEqual(splitLeadingSymbol('info: plain'), {
      indent: '',
      symbol: undefined,
      rest: 'info: plain',
    });
  });

  it('stripSpinner drops braille glyphs (F4)', () => {
    assert.equal(stripSpinner('⠋ building app'), 'building app');
    assert.equal(stripSpinner('plain'), 'plain');
  });

  it('parseWheelEvents reads SGR reports, ignoring releases and clicks (F1)', () => {
    assert.deepEqual(parseWheelEvents('\u001b[<64;5;2M'), [
      { dir: 'up', col: 5, row: 2 },
    ]);
    // ink strips the leading ESC before the handler sees the chunk.
    assert.deepEqual(parseWheelEvents('[<65;40;3M'), [
      { dir: 'down', col: 40, row: 3 },
    ]);
    // Press+release in ONE chunk parses to exactly one notch.
    assert.deepEqual(parseWheelEvents('[<65;40;3M[<65;40;3m'), [
      { dir: 'down', col: 40, row: 3 },
    ]);
    assert.deepEqual(parseWheelEvents('[<65;40;3m'), []); // release only
    assert.deepEqual(parseWheelEvents('[<0;40;3M'), []); // click, not wheel
    assert.deepEqual(parseWheelEvents('q'), []);
    assert.deepEqual(parseWheelEvents(''), []);
  });

  it('isMouseOnlyInput recognizes mouse traffic for swallowing', () => {
    assert.equal(isMouseOnlyInput('[<0;40;3M[<0;40;3m'), true);
    assert.equal(isMouseOnlyInput('[<65;40;3m'), true);
    assert.equal(isMouseOnlyInput('q'), false);
    assert.equal(isMouseOnlyInput('[<0;40;3Mq'), false);
    assert.equal(isMouseOnlyInput(''), false);
  });
});
