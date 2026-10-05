// Terminal-hygiene contract of the ink wizard port (`createTuiPromptPort`,
// src/cli/dev-tui/wizard.tsx). The port is the seam between the wizard flow and
// one ink session, so what this file locks is the part that can corrupt a
// terminal: who owns raw mode and the cursor, what `close()` leaves behind, and
// what happens to a question still open when the caller walks away.
//
// Streams are fakes (the same shape ink-testing-library builds), so the test
// runs without a pty. The interaction contract itself lives in
// dev-tui-wizard.test.ts; here keystrokes only appear where they are the
// simplest way to settle a question.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createTuiPromptPort, isInkCiMode } from '../../src/cli/dev-tui/wizard.js';

/**
 * Minimal write stream: records every write. Non-TTY by default so ink never
 * goes fullscreen; the TTY variant (`isTTY: true`) is what makes ink diff
 * frames and listen for `resize`, so the final-frame and reflow tests use it.
 * `columns` is writable: a resize test shrinks it before emitting 'resize'.
 */
class FakeStdout extends EventEmitter {
  columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  readonly chunks: string[] = [];
  readonly setEncoding = (): void => undefined;
  constructor({ isTTY = false, columns = 100, rows = 24 } = {}) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
    this.rows = rows;
  }
  write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };
  /** Everything written so far, as one string. */
  get text(): string {
    return this.chunks.join('');
  }
}

/** Minimal raw-mode stdin: records the mode/pause calls the port must make. */
class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  rawMode = false;
  paused = false;
  refCalls = 0;
  unrefCalls = 0;
  private pending: string | null = null;
  setEncoding = (): void => undefined;
  setRawMode = (enabled: boolean): void => {
    this.rawMode = enabled;
  };
  resume = (): void => {
    this.paused = false;
  };
  pause = (): void => {
    this.paused = true;
  };
  ref = (): void => {
    this.refCalls += 1;
  };
  unref = (): void => {
    this.unrefCalls += 1;
  };
  /** Push bytes the way a terminal would (raw mode: one write per keystroke). */
  send = (data: string): void => {
    this.pending = data;
    this.emit('readable');
  };
  read = (): string | null => {
    const data = this.pending;
    this.pending = null;
    return data;
  };
}

const wait = (ms = 40): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  readonly port: ReturnType<typeof createTuiPromptPort>;
  readonly stdin: FakeStdin;
  readonly stdout: FakeStdout;
}

function harness(
  color: boolean,
  screen: ConstructorParameters<typeof FakeStdout>[0] = {}
): Harness {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(screen);
  return {
    port: createTuiPromptPort({
      // Cast: the fakes implement the slice of the stream contract ink uses.
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      color,
    }),
    stdin,
    stdout,
  };
}

// PromptPort takes mutable arrays, so this is built fresh per call.
const remotesQuestion = () => ({
  message: 'Which remotes to run?',
  options: [
    { value: 'mini_auth', label: 'mini_auth' },
    { value: 'mini_store', label: 'mini_store' },
  ],
  initialValues: ['mini_auth', 'mini_store'],
  emptyHint: 'host only',
});

/** One Enter keypress through ink's parser (raw mode sends CR). */
const pressEnter = async (stdin: FakeStdin): Promise<void> => {
  stdin.send('\r');
  await wait();
};

// ink's `is-in-ci` mode (CI set to anything but 0/false, even empty, as
// every CI runner does) SKIPS per-frame writes to a TTY stdout: it buffers frames
// and only flushes static output plus the LAST frame at unmount. Live
// frames therefore never reach this fake TTY stdout mid-question in that
// mode. Frame CONTENT stays covered CI-safely by the ink-testing-library
// suites (non-TTY stdout → plain writes in every mode); this suite keeps
// proving session behavior here (raw mode, keys, promises, hygiene), and
// these content assertions stay enforced for local runs.
const ciMode = isInkCiMode(process.env);

describe('tui prompt port: terminal hygiene', () => {
  it('takes raw mode for the live question and hands it back on close', async () => {
    const { port, stdin, stdout } = harness(false);
    const answer = port.multiselect(remotesQuestion());
    await wait();
    assert.equal(stdin.rawMode, true, 'ink must own raw mode while asking');
    if (!ciMode) assert.match(stdout.text, /Which remotes to run\?/);

    await pressEnter(stdin);
    assert.deepEqual(await answer, {
      status: 'ok',
      value: ['mini_auth', 'mini_store'],
    });

    port.close();
    assert.equal(stdin.rawMode, false, 'raw mode must be OFF after close');
    assert.equal(stdin.paused, true, 'stdin must end paused for the dashboard');
    assert.match(stdout.text, /\[\?25h/, 'the cursor must be shown again');
    // Separation from what the caller prints next (the `dev:` conflict lines):
    // close() ends the standing frame with a blank row, so the error block
    // never lands flush under it (real-PTY check, 2026-10-02).
    const esc = String.fromCharCode(0x1b);
    const lastCursor = stdout.text.lastIndexOf(`${esc}[?25h`);
    assert.match(
      stdout.text.slice(lastCursor + `${esc}[?25h`.length),
      /^\n/,
      'close must leave a blank line after the last ink frame'
    );
  });

  it('leaves the settled answer on screen through the session', async () => {
    const { port, stdin, stdout } = harness(false);
    const answer = port.multiselect(remotesQuestion());
    await wait();
    stdin.send(' '); // untick the focused remote
    await wait();
    await pressEnter(stdin);
    assert.deepEqual(await answer, { status: 'ok', value: ['mini_store'] });
    // The recap lives in the live summary panel now (not ink <Static>), so in
    // ink's CI mode no per-frame write carries it — see the ciMode note above.
    // Panel CONTENT is covered CI-safely in dev-tui-wizard-app.test.tsx.
    if (!ciMode) {
      assert.match(stdout.text, /mini_store/, 'the recap carries the answer');
    }
    port.close();
  });

  it('resolves a dangling question as cancelled and is idempotent on close', async () => {
    const { port, stdin } = harness(false);
    const answer = port.multiselect(remotesQuestion());
    await wait();
    port.close();
    assert.deepEqual(await answer, { status: 'cancelled' });
    const rawModeAfterFirstClose = stdin.rawMode;
    port.close();
    port.close();
    assert.equal(stdin.rawMode, rawModeAfterFirstClose, 'close must not thrash');
    assert.equal(stdin.paused, true);
  });

  it('answers cancelled after close instead of mounting a new session', async () => {
    const { port, stdin, stdout } = harness(false);
    port.close();
    const before = stdout.chunks.length;
    assert.deepEqual(await port.confirm({ message: 'Ship it?' }), {
      status: 'cancelled',
    });
    assert.deepEqual(await port.select({ message: 'Platform?', options: [{ value: 'ios', label: 'iOS' }] }), {
      status: 'cancelled',
    });
    assert.deepEqual(await port.text({ message: 'Port:' }), {
      status: 'cancelled',
    });
    assert.equal(stdin.rawMode, false, 'a closed port must never take raw mode');
    assert.equal(
      stdout.chunks.length,
      before,
      'a closed port must not ask anything on screen'
    );
  });

  it('cancels the live question on Ctrl-C and every later one', async () => {
    const { port, stdin } = harness(false);
    const first = port.multiselect(remotesQuestion());
    await wait();
    stdin.send('\u0003'); // ETX = Ctrl-C in raw mode
    await wait();
    assert.deepEqual(await first, { status: 'cancelled' });
    // Sticky: the next question answers cancelled without waiting for a key.
    assert.deepEqual(await port.confirm({ message: 'Ship it?' }), {
      status: 'cancelled',
    });
    port.close();
  });

  it('cancels the live question on Escape', async () => {
    const { port, stdin } = harness(false);
    const answer = port.confirm({ message: 'Ship it?' });
    await wait();
    stdin.send('\u001b');
    await wait();
    assert.deepEqual(await answer, { status: 'cancelled' });
    port.close();
  });

  it('routes real keys through ink: space toggles, arrows move, enter settles', async () => {
    const { port, stdin } = harness(false);
    const answer = port.multiselect(remotesQuestion());
    await wait();
    // One write per keystroke: raw mode sends each key as its own chunk, and
    // ink parses one event per chunk boundary (a burst of DELs in one write
    // would be ONE keypress — no terminal can type that).
    stdin.send(' '); // untick the focused mini_auth
    await wait();
    stdin.send('\u001b[B'); // down arrow -> mini_store
    await wait();
    stdin.send(' '); // untick it too…
    await wait();
    stdin.send('\u001b[A'); // up arrow
    await wait();
    stdin.send(' '); // …tick mini_auth back
    await wait();
    await pressEnter(stdin);
    assert.deepEqual(await answer, { status: 'ok', value: ['mini_auth'] });
    port.close();
  });

  it('answers a confirm with y and n without a second keypress', async () => {
    const { port, stdin } = harness(false);
    const yes = port.confirm({ message: 'Launch on ios when ready?' });
    await wait();
    stdin.send('y');
    await wait();
    assert.deepEqual(await yes, { status: 'ok', value: true });

    const no = port.confirm({ message: 'Run mini_auth standalone?' });
    await wait();
    stdin.send('n');
    await wait();
    assert.deepEqual(await no, { status: 'ok', value: false });
    port.close();
  });

  it('types a port through the validator before accepting it', async () => {
    const { port, stdin, stdout } = harness(false);
    const answer = port.text({
      message: 'Port for Atlas Host:',
      validate: (value: string): string | undefined =>
        /^\d+$/.test(value) ? undefined : 'Enter an integer port between 1 and 65535.',
    });
    await wait();
    stdin.send('nope');
    await wait();
    await pressEnter(stdin);
    if (!ciMode) {
      assert.match(
        stdout.text,
        /integer port/,
        'the validator message must be visible, not swallowed'
      );
    }
    // One DEL per write: raw mode delivers one keypress per chunk.
    for (const _ of [0, 1, 2, 3]) {
      stdin.send('\u007F'); // DEL = backspace in raw mode
      await wait(20);
    }
    stdin.send('9001');
    await wait();
    await pressEnter(stdin);
    assert.deepEqual(await answer, { status: 'ok', value: '9001' });
    port.close();
  });
});

describe('tui prompt port: the final frame', () => {
  // Regression (real PTY): the last answer's setState is queued in a React
  // microtask, and the awaiting wizard calls close() first. Without the sync
  // rerender in close(), ink's final frame still drew the last question live
  // (`● Q2 last?`) and its recap was missing from the panel. A TTY stdout is
  // what makes ink diff frames; in CI mode ink flushes only the final frame at
  // unmount, which is exactly the frame under test, so this runs in both.
  it('holds the last answer in the panel when close() follows the answer at once', async () => {
    const { port, stdin, stdout } = harness(false, { isTTY: true, columns: 100, rows: 40 });
    const first = port.confirm({ message: 'Q1?' });
    await wait(60);
    stdin.send('y');
    assert.deepEqual(await first, { status: 'ok', value: true });
    const last = port.confirm({ message: 'Q2 last?' });
    await wait(60);
    stdin.send('y');
    assert.deepEqual(await last, { status: 'ok', value: true });
    port.close(); // no wait: the wizard's await resumes straight into close()

    const finalFrame = stdout.text.slice(stdout.text.lastIndexOf('╭'));
    assert.match(finalFrame, /✓ Q2 last\? yes/, 'the last recap is in the panel');
    assert.doesNotMatch(finalFrame, /● Q2 last\?/, 'no question is left live');
  });
});

describe('tui prompt port: terminal resize', () => {
  // On a width decrease ink erases only the rows it wrote, while the terminal
  // has already re-wrapped the wider frame into more rows: the panel's top
  // border survived as stacked ghosts (real terminal). The port answers with
  // a delete-lines compensation written BEFORE ink's own erase. ink only
  // listens for 'resize' outside CI mode, and so does the port.
  it('deletes the re-wrapped rows before ink erases its frame on a shrink', async () => {
    const { port, stdin, stdout } = harness(false, { isTTY: true, columns: 100, rows: 40 });
    const first = port.confirm({
      message: 'Launch the host on the booted simulator once the bundler is ready?',
    });
    await wait(60);
    stdin.send('y');
    assert.deepEqual(await first, { status: 'ok', value: true });
    const live = port.confirm({ message: 'Q2?' });
    await wait(60);

    const esc = String.fromCharCode(0x1b);
    const before = stdout.chunks.length;
    stdout.columns = 40;
    stdout.emit('resize');
    await wait(60);
    const after = stdout.chunks.slice(before);
    const compensation = after.findIndex((chunk) =>
      new RegExp(`^\\r${esc}\\[\\d+A${esc}\\[\\d+M${esc}\\[\\d+B$`).test(chunk)
    );
    if (ciMode) {
      assert.equal(compensation, -1, 'no compensation where ink does not redraw');
    } else {
      const erase = after.findIndex((chunk) => chunk.includes(`${esc}[2K`));
      assert.notEqual(compensation, -1, 'the compensation sequence is written');
      assert.notEqual(erase, -1, "ink's own erase follows");
      assert.ok(compensation < erase, "the compensation lands before ink's erase");
    }

    // Growing back is ink's job alone: nothing extra wrapped.
    const grown = stdout.chunks.length;
    stdout.columns = 100;
    stdout.emit('resize');
    await wait(60);
    assert.ok(
      !stdout.chunks.slice(grown).some((chunk) => new RegExp(`${esc}\\[\\d+M`).test(chunk)),
      'a width increase deletes nothing'
    );

    stdin.send('n');
    assert.deepEqual(await live, { status: 'ok', value: false });
    port.close();
    assert.equal(stdout.listenerCount('resize'), 0, 'close() drops every resize listener');
  });
});

describe('tui prompt port: durable lines', () => {
  it('writes a note and the walk-away line straight to stdout before any question', async () => {
    const { port, stdout } = harness(false);
    port.note('Launch skipped: launching the app needs a single platform.');
    port.cancel('Session cancelled.');
    assert.match(
      stdout.text,
      /^Launch skipped: launching the app needs a single platform\.$/m,
      'plain mode writes the line verbatim'
    );
    assert.match(stdout.text, /^Session cancelled\.$/m);
    assert.ok(
      !stdout.text.includes('\u001b['),
      'color=false must not emit SGR bytes for these lines'
    );
    port.close();
  });

  it('paints them with the hand-rolled SGR subset when color is on', async () => {
    const { port, stdout } = harness(true);
    port.note('a note');
    port.cancel('Session cancelled.');
    const esc = String.fromCharCode(0x1b);
    assert.match(stdout.text, new RegExp(`${esc}\\[2ma note`), 'dim note');
    assert.match(
      stdout.text,
      new RegExp(`${esc}\\[32mSession cancelled\\.`),
      'green walk-away line'
    );
    port.close();
  });

  it('routes both through the live session once a question is mounted', async () => {
    const { port, stdin, stdout } = harness(false);
    const answer = port.confirm({ message: 'Ship it?' });
    await wait();
    const beforeQuestion = stdout.text;
    port.note('between questions');
    await wait();
    // Same CI-mode frame skip as above: the durable note reaches the fake TTY
    // stdout through the live session, which ink buffers in CI mode.
    if (!ciMode) {
      assert.match(stdout.text, /between questions/);
      assert.notEqual(stdout.text, beforeQuestion, 'the session repaints');
    } else {
      assert.notEqual(stdin.rawMode, false, 'the session is still the live route');
    }
    await pressEnter(stdin);
    assert.deepEqual(await answer, { status: 'ok', value: true });
    port.close();
  });
});
