/** @jsxImportSource react */
// Smoke tests for the ink dashboard (T3). The pure logic lives in the model
// suite; these prove the component TREE renders the model and reacts to keys
// — via ink-testing-library, whose mock stdout strips colors (non-TTY), so
// assertions match plain text. `render` here is the test helper, not ink's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanup, render } from 'ink-testing-library';
import { DevTuiApp, logWindow, truncate } from '../../src/cli/dev-tui/app.js';
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(app.lastFrame() ?? '', /▍● online-store/);
    assert.match(app.lastFrame() ?? '', /building the remote/);
    // Tab from the last row wraps to the first.
    model.selectLast();
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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
});

describe('dev tui view helpers', () => {
  it('truncate keeps width and marks cuts', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.equal(truncate('hello world', 5), 'hell…');
    assert.equal(truncate('hello world', 5).length, 5);
    assert.equal(truncate('ab', 1), '…');
    assert.equal(truncate('ab', 0), '');
  });

  it('logWindow anchors at the bottom and clamps the offset', () => {
    assert.deepEqual(logWindow(10, 0, 5), { start: 5, end: 10 });
    assert.deepEqual(logWindow(10, 3, 5), { start: 2, end: 7 });
    // Offset beyond the buffer still keeps at least one line.
    assert.deepEqual(logWindow(3, 100, 5), { start: 0, end: 1 });
    assert.deepEqual(logWindow(0, 5, 5), { start: 0, end: 0 });
  });
});
