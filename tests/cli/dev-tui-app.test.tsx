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
  activityBadge,
  animateLiveDots,
  DevTuiApp,
  isMouseOnlyInput,
  parseWheelEvents,
  splitLeadingSymbol,
  splitTimestamp,
  stripSpinner,
  symbolColor,
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
    // F8: once a terminal line lands, the pin DIES even while the bar is
    // still recent, and the bar settles as ONE completed 100% frame in the
    // body flow — never a pinned 98/93% bar parked under `Compiled`.
    model.log('host', 'stdout', '✔ Compiled in 4.2s');
    await wait(150);
    const after = (app.lastFrame() ?? '').split('\n');
    const barRow = after.findIndex((l) => /100%/.test(l));
    const compiledRow = after.findIndex((l) => /Compiled/.test(l));
    assert.ok(barRow >= 0, 'the bar renders completed at 100%');
    assert.ok(compiledRow > barRow, 'the completed bar flows as history');
    assert.equal(
      after.filter((l) => /93%/.test(l)).length,
      0,
      'the stale 93% frame is replaced in place, never shown alongside'
    );
    // Later lines keep flowing normally.
    model.log('host', 'stdout', 'info: asset main.js 1.2 MiB');
    model.log('host', 'stdout', 'warning: entrypoint size limit');
    await wait(150);
    const later = (app.lastFrame() ?? '').split('\n');
    assert.ok(
      later.some((l) => /asset main\.js/.test(l)),
      'later lines still render'
    );
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

  it('renders ascii fallback symbols as level glyphs (F9)', () => {
    const model = createDevTuiModel({
      apps: [{ key: 'host', name: 'host', role: 'host', port: 8081 }],
    });
    model.log('host', 'stdout', 'i dependency resolved');
    model.log('host', 'stdout', '! watch warning');
    model.log('host', 'stdout', 'x compilation failed');
    model.log('host', 'stdout', '✓ Compiled in 4s');
    model.log('host', 'stdout', '-> https://example.com/mf.json');
    const app = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    const frame = app.lastFrame() ?? '';
    assert.match(frame, /i dependency resolved/);
    assert.match(frame, /! watch warning/);
    assert.match(frame, /x compilation failed/);
    assert.match(frame, /✓ Compiled in 4s/);
    assert.match(frame, /-> https:\/\/example\.com\/mf\.json/);
    // The `! ` symbol reads as the warn glyph, so no double stderr marker.
    assert.doesNotMatch(frame, /! !/);
    app.unmount();
    app.cleanup();
  });

  it('shows an unread-activity badge on non-selected rows and clears it on view (F10)', async () => {
    const model = createDevTuiModel({
      apps: [
        { key: 'host', name: 'host', role: 'host', port: 8081 },
        { key: 'alpha', name: 'alpha', role: 'remote', port: 8082 },
      ],
    });
    const app = render(
      <DevTuiApp model={model} onQuit={() => undefined} frame={0} />
    );
    await wait(150);
    // Logs for the NON-selected row carry a badge (glyph + count).
    model.log('alpha', 'stdout', 'building');
    model.log('alpha', 'stdout', 'still building');
    await wait(150);
    assert.match(app.lastFrame() ?? '', /alpha 8082 ·2/);
    // Selecting the row clears the badge (markViewed via the selection effect).
    app.stdin.write('\u001B[B'); // down -> alpha
    await wait(150);
    assert.doesNotMatch(app.lastFrame() ?? '', /·2/);
    // Logs on the selected row never badge (`·1` would be the badge; the
    // footer's `·` separators are not one).
    model.log('alpha', 'stdout', 'watched');
    await wait(150);
    assert.doesNotMatch(app.lastFrame() ?? '', /·1/);
    app.unmount();
    app.cleanup();
  });

  it('toggles mouse reporting with m and gates wheel routing (F11)', async () => {
    const model = seededModel();
    for (let i = 1; i <= 40; i += 1) {
      model.log('host', 'stdout', `line ${i}`);
    }
    const app = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    await wait(150);
    assert.match(app.lastFrame() ?? '', /m mouse on/);
    // Wheel off: a sidebar wheel report must NOT move the selection.
    app.stdin.write('m');
    await wait(150);
    assert.match(app.lastFrame() ?? '', /m mouse off/);
    assert.match(app.lastFrame() ?? '', /drag copy/);
    app.stdin.write('\u001b[<65;5;2M\u001b[<65;5;2m');
    await wait(150);
    assert.equal(model.selectedIndex(), 0, 'stale wheel bytes are inert');
    // Toggle back on and the same report routes again.
    app.stdin.write('m');
    await wait(150);
    assert.match(app.lastFrame() ?? '', /m mouse on/);
    app.stdin.write('\u001b[<65;5;2M\u001b[<65;5;2m');
    await wait(150);
    assert.equal(model.selectedIndex(), 1);
    app.unmount();
    app.cleanup();
  });

  it('types a line and sends it to the selected app on Enter (F12)', async () => {
    const model = seededModel();
    const sent: { key: string; line: string }[] = [];
    const app = render(
      <DevTuiApp
        model={model}
        onQuit={() => undefined}
        onSendInput={(key, line) => {
          sent.push({ key, line });
          return true;
        }}
      />
    );
    await wait(150);
    // Footer advertises the honest capability while a route exists.
    assert.match(app.lastFrame() ?? '', /i send line to stdin/);
    // `i` opens the prompt at the panel bottom.
    app.stdin.write('i');
    await wait(150);
    assert.match(app.lastFrame() ?? '', /› /);
    // Printable chars append; Backspace trims; the draft renders.
    app.stdin.write('rs');
    await wait(150);
    app.stdin.write('\u007F'); // DEL = backspace in raw mode
    await wait(150);
    assert.match(app.lastFrame() ?? '', /› r\b/);
    // Enter sends the exact line with the selected row's key, then closes.
    // (Each real key is its own keypress chunk — ink parses a burst like
    // `s\r` as ONE keypress, so Enter goes on its own write, as terminals
    // always deliver it.)
    app.stdin.write('s');
    await wait(150);
    app.stdin.write('\r');
    await wait(150);
    assert.deepEqual(sent, [{ key: 'host', line: 'rs' }]);
    assert.doesNotMatch(app.lastFrame() ?? '', /› /);
    // Esc cancels without sending.
    app.stdin.write('i');
    await wait(150);
    app.stdin.write('abc');
    await wait(150);
    app.stdin.write('\u001B');
    await wait(150);
    assert.equal(sent.length, 1, 'Escape discarded the draft');
    // An empty Enter sends nothing.
    app.stdin.write('i');
    await wait(150);
    app.stdin.write('\r');
    await wait(150);
    assert.equal(sent.length, 1);
    // Without the prop the mode cannot open at all (machine-safe default).
    const plain = render(<DevTuiApp model={model} onQuit={() => undefined} />);
    await wait(150);
    plain.stdin.write('i');
    await wait(150);
    assert.doesNotMatch(plain.lastFrame() ?? '', /› /);
    app.unmount();
    plain.unmount();
    app.cleanup();
    plain.cleanup();
  });

  it('input mode never opens on the one-shot row and swallows the keymap (F12)', async () => {
    const model = seededModel(); // includes the `launch` oneshot row
    const sent: { key: string; line: string }[] = [];
    const quits = { n: 0 };
    const app = render(
      <DevTuiApp
        model={model}
        onQuit={() => (quits.n += 1)}
        onSendInput={(key, line) => {
          sent.push({ key, line });
          return true;
        }}
      />
    );
    await wait(150);
    model.selectLast(); // -> `launch` (oneshot)
    await wait(150);
    app.stdin.write('i');
    await wait(150);
    assert.doesNotMatch(app.lastFrame() ?? '', /› /, 'oneshot is not routable');
    // While open on a ROUTABLE row, `q` must not quit (input mode owns keys).
    model.selectFirst();
    await wait(150);
    app.stdin.write('iq');
    await wait(150);
    assert.equal(quits.n, 0, 'q typed in the draft is text, not quit');
    assert.deepEqual(sent, []);
    app.stdin.write('\u001B'); // Esc out
    await wait(150);
    app.stdin.write('q');
    await wait(150);
    assert.equal(quits.n, 1, 'q works again after Esc');
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

  it('splitLeadingSymbol detects the ascii fallback set (F9)', () => {
    assert.deepEqual(splitLeadingSymbol('i dependency resolved'), {
      indent: '',
      symbol: 'i',
      rest: 'dependency resolved',
    });
    assert.deepEqual(splitLeadingSymbol('! watch warning'), {
      indent: '',
      symbol: '!',
      rest: 'watch warning',
    });
    assert.deepEqual(splitLeadingSymbol('x compilation failed'), {
      indent: '',
      symbol: 'x',
      rest: 'compilation failed',
    });
    assert.deepEqual(splitLeadingSymbol('✓ Compiled'), {
      indent: '',
      symbol: '✓',
      rest: 'Compiled',
    });
    assert.deepEqual(splitLeadingSymbol('-> https://x/mf.json'), {
      indent: '',
      symbol: '->',
      rest: 'https://x/mf.json',
    });
    // The space requirement is what keeps `iO`-style words out:
    assert.deepEqual(splitLeadingSymbol('iO-saurus'), {
      indent: '',
      symbol: undefined,
      rest: 'iO-saurus',
    });
    assert.deepEqual(splitLeadingSymbol('index.js 1.2 MiB'), {
      indent: '',
      symbol: undefined,
      rest: 'index.js 1.2 MiB',
    });
    // Colors follow Re.Pack's fallback map.
    assert.equal(symbolColor('i'), 'blue');
    assert.equal(symbolColor('!'), 'yellow');
    assert.equal(symbolColor('x'), 'red');
    assert.equal(symbolColor('✓'), 'green');
    assert.equal(symbolColor('->'), 'cyan');
  });

  it('splitTimestamp splits ONLY a leading bracketed timestamp (F9)', () => {
    assert.deepEqual(splitTimestamp('[14:37:11.074Z][DevServer] ready'), {
      stamp: '[14:37:11.074Z]',
      rest: '[DevServer] ready',
    });
    assert.deepEqual(splitTimestamp('[14:37:11Z] plain'), {
      stamp: '[14:37:11Z]',
      rest: ' plain',
    });
    // A time mid-message stays part of the message.
    assert.deepEqual(splitTimestamp('built at [14:37:11Z] today'), {
      stamp: undefined,
      rest: 'built at [14:37:11Z] today',
    });
    assert.deepEqual(splitTimestamp('no time here'), {
      stamp: undefined,
      rest: 'no time here',
    });
  });

  it('activityBadge is a ≤4-char animated marker, capped 99+ (F10)', () => {
    assert.equal(activityBadge(0, 0), '');
    assert.equal(activityBadge(2, 0), '·2');
    // The bounce cycles through the four glyphs with the frame counter.
    const glyphs = [0, 1, 2, 3].map((f) => activityBadge(1, f)[0]);
    assert.deepEqual(glyphs, ['·', '▁', '▃', '▁']);
    assert.equal(activityBadge(99, 0), '·99');
    assert.equal(activityBadge(100, 0), '·99+');
    assert.ok(activityBadge(5, 1).length <= 4);
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
