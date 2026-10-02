#!/usr/bin/env node
// Dev-only render probe for the `dev` dashboard. Not part of the published
// package: `tools/` is outside the tsconfig `include`, the package ships
// `files: ["dist"]` only, and this adds no runtime dependency (AGENTS.md
// rule 11). It imports the COMPILED output like any consumer would, so run
// `pnpm build` first.
//
// It answers two questions with numbers instead of impressions, so a future
// "this feels slow" gets measured rather than argued about:
//
//   1. CPU  — what does one frame cost, and does it grow with the log buffer?
//             (React reconciliation + Yoga layout + the pure model snapshot.)
//   2. I/O  — how many bytes does the render layer write per frame? Perceived
//             smoothness lives here, not in CPU: an ANSI terminal repaints by
//             rewriting text, so a frame that rewrites the whole viewport
//             costs proportionally to the TERMINAL SIZE rather than to what
//             changed. That scaling is the signal this probe exists to show.
//
//   pnpm build && node tools/tui-perf.mjs
//   node tools/tui-perf.mjs --lines 2000 --frames 20 --apps 3
//
// Both sections default to `patchConsole: false`, which measures the cost of
// THIS app. The shipped dashboard mount does not set it, so passing
// `--with-console` measures that instead: a single React dev warning then
// paints inside the viewport on every frame, which is a different (and much
// larger) number. Report which one you are looking at.
//
// The I/O numbers need a real pseudo-terminal, because a render layer is
// allowed to take different paths for a TTY. Without one they collapse to
// identical small values and prove nothing. Run it under a PTY:
//
//   script -q /dev/null node tools/tui-perf.mjs        # macOS/BSD
//   script -qec 'node tools/tui-perf.mjs' /dev/null    # Linux
//
// Reports go to stderr so stdout stays the measured stream. This is a
// hand-run probe, not a CI gate: terminal throughput is machine-,
// terminal- and load-dependent, so a threshold here would only produce
// flaky failures.

import process from 'node:process';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
// The promise-based timer is also the inter-frame spacer: it cannot be
// mistaken for work being measured.
import { setTimeout as sleep } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const report = (text) => process.stderr.write(`${text}\n`);
const pad = (value, width) => String(value).padStart(width);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `node tools/tui-perf.mjs [--lines N] [--frames N] [--spacing MS] [--apps N]
                        [--sizes a,b,c] [--with-console]

Measures the dev dashboard render layer: CPU per frame (a fake 120x40 stream)
and bytes per frame (the real stdout, A/B'd across terminal widths). Run
'pnpm build' first, and run under a PTY (script -q) for the byte numbers to
mean anything.

--with-console measures the console-painted behavior of the shipped mount
(the dashboard does not pass patchConsole: false) instead of isolating this
app's own cost.`;

const DEFAULTS = {
  lines: 2000, // log lines in the buffer (the ring cap is DEV_TUI_RING_CAP)
  frames: 12, // rerenders per measured run
  spacingMs: 50, // > the renderer's own frame throttle, so frames really paint
  apps: 3,
  sizes: [80, 160], // terminal widths for the I/O scaling check
  patchConsole: false, // see the header note: true = the shipped mount's behavior
};

function parseArgv(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--lines') options.lines = Number(next());
    else if (arg === '--frames') options.frames = Number(next());
    else if (arg === '--spacing') options.spacingMs = Number(next());
    else if (arg === '--apps') options.apps = Number(next());
    else if (arg === '--sizes')
      options.sizes = next()
        .split(',')
        .map((part) => Number(part.trim()))
        .filter(Number.isFinite);
    else if (arg === '--with-console') options.patchConsole = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      report(`tui-perf: unknown argument ${arg} (try --help)`);
      process.exit(2);
    }
  }
  for (const key of ['lines', 'frames', 'spacingMs', 'apps']) {
    if (!Number.isFinite(options[key]) || options[key] < 1) {
      report(`tui-perf: --${key} needs a positive number`);
      process.exit(2);
    }
  }
  if (options.sizes.length < 1) {
    report('tui-perf: --sizes needs at least one width');
    process.exit(2);
  }
  return options;
}

/** The installed ink version, resolved from THIS repo (never from tools/). */
function installedRenderVersion() {
  try {
    const require = createRequire(path.join(repoRoot, 'package.json'));
    // ink's exports map hides package.json, so read the file above its entry.
    const entry = require.resolve('ink');
    const pkg = path.resolve(path.dirname(entry), '..', 'package.json');
    return JSON.parse(require('node:fs').readFileSync(pkg, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * A writable that looks like a terminal to the renderer and to the app's
 * `useStdout` size checks, and counts bytes instead of drawing. Keeps the CPU
 * numbers independent of the human's terminal.
 */
function createFakeStdout(columns, rows) {
  const stream = new PassThrough();
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  let bytes = 0;
  stream.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
  });
  return { stream, bytes: () => bytes };
}

/** A stream that behaves like a TTY for input but never delivers any. */
function createIdleStdin() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = () => stream;
  // ink's App enables raw mode by ref()/setRawMode()/addListener('readable'),
  // and unref()s it on teardown, so the stand-in has to answer all of them.
  stream.ref = () => stream;
  stream.unref = () => stream;
  stream.setEncoding = () => stream;
  stream.setFlowing = () => stream;
  return stream;
}

function createModel(createDevTuiModel, appCount, totalLines) {
  const apps = Array.from({ length: appCount }, (_, i) => ({
    key: i === 0 ? 'host' : `remote-${i}`,
    name: i === 0 ? 'host' : `remote-${i}`,
    role: i === 0 ? 'host' : 'remote',
    port: 8081 + i,
  }));
  const model = createDevTuiModel({ apps });
  for (let i = 0; i < totalLines; i += 1) {
    model.log(apps[0].key, 'stdout', `line ${i} a moderately long build log line to lay out`);
  }
  return model;
}

/** One progress-bar frame, so every measured frame really changes the screen. */
function progressLine(frame) {
  const percent = (frame * 7) % 100;
  const filled = frame % 20;
  return `Compiling modules ${percent}% [${'='.repeat(filled)}${'-'.repeat(20 - filled)}]`;
}

/**
 * Bytes written to stdout, from Node's own counter. Wrapping
 * `process.stdout.write` was tried first and silently missed the frames the
 * render layer actually painted, so this reads the native writable statistic
 * instead: it cannot be bypassed by anything holding an older reference.
 */
function stdoutBytesWritten() {
  const value = process.stdout.bytesWritten;
  return typeof value === 'number' ? value : 0;
}

/**
 * Per-frame cost, measured with the render layer's own instrument.
 *
 * Three naive ways to measure this are all wrong, and two were tried:
 *   · Timing a synchronous burst of rerenders measures ENQUEUE time, because
 *     the renderer coalesces frames below its own throttle (it looked ~1 ms).
 *   · Timing spaced frames and dividing by the count folds the sleep between
 *     frames into the average (it looked ~55 ms at a 50 ms spacing).
 *   · Timing the `rerender` call alone still misses work the renderer does
 *     after the call returns.
 * The render layer reports its own time per painted frame through the
 * `onRender({ renderTime })` option, so that is what this collects; the sleep
 * between frames only lets each paint actually happen.
 */
function collectRenderTimes(onRender) {
  const samples = [];
  return {
    samples,
    onRender(event) {
      samples.push(event.renderTime);
      onRender?.(event);
    },
    mean() {
      if (samples.length === 0) return Number.NaN;
      return samples.reduce((sum, x) => sum + x, 0) / samples.length;
    },
  };
}

async function measureCpu({ tui, ink, react, createDevTuiModel }, options) {
  report('');
  report(
    `CPU per frame (fake 120x40 stream, ${options.frames} frames, ` +
      `patchConsole=${String(options.patchConsole)}):`,
  );
  report(
    `  lines   snapshot(ms)   render(ms/frame)   [from the renderer's onRender]`,
  );
  const sizes = [...new Set([200, 1000, options.lines])].sort((a, b) => a - b);
  for (const lines of sizes) {
    const model = createModel(createDevTuiModel, options.apps, lines);
    const snapshotStart = performance.now();
    for (let i = 0; i < 200; i += 1) model.snapshot();
    const snapshotMs = (performance.now() - snapshotStart) / 200;

    const fake = createFakeStdout(120, 40);
    const stdin = createIdleStdin();
    const times = collectRenderTimes();
    const instance = ink.render(
      react.createElement(tui.DevTuiApp, { model, onQuit() {}, frame: 0 }),
      {
        stdout: fake.stream,
        stdin,
        exitOnCtrlC: false,
        patchConsole: options.patchConsole,
        onRender: times.onRender,
      },
    );
    await sleep(200);
    for (let f = 1; f <= options.frames; f += 1) {
      instance.rerender(
        react.createElement(tui.DevTuiApp, { model, onQuit() {}, frame: f }),
      );
      await sleep(options.spacingMs);
    }
    await sleep(options.spacingMs);
    instance.unmount();
    await sleep(50);
    report(
      `  ${pad(lines, 5)}   ${pad(snapshotMs.toFixed(3), 10)}   ${times.mean().toFixed(2)}` +
        `   (${times.samples.length} painted frames)`,
    );
  }
}

async function measureIo({ tui, ink, react, createDevTuiModel }, options) {
  report('');
  report(
    `Bytes per frame under load (${options.frames} frames, one new line each, ` +
      `patchConsole=${String(options.patchConsole)}):`,
  );
  for (const columns of options.sizes) {
      // The dashboard sizes itself to the terminal, so this varies the frame
      // HEIGHT and WIDTH together, which is what a full-viewport repaint costs.
      process.stdout.columns = columns;
      process.stdout.rows = Math.max(12, Math.floor(columns / 3));
      const model = createModel(createDevTuiModel, options.apps, options.lines);
      const stdin = createIdleStdin();
      const instance = ink.render(
        react.createElement(tui.DevTuiApp, { model, onQuit() {}, frame: 0 }),
        {
          stdout: process.stdout,
          stdin,
          exitOnCtrlC: false,
          patchConsole: options.patchConsole,
        },
      );
      await sleep(300);
      const before = stdoutBytesWritten();
      for (let f = 1; f <= options.frames; f += 1) {
        model.log('host', 'stdout', progressLine(f));
        instance.rerender(
          react.createElement(tui.DevTuiApp, { model, onQuit() {}, frame: f }),
        );
        await sleep(options.spacingMs);
      }
      await sleep(300);
      const perFrame = (stdoutBytesWritten() - before) / options.frames;
      instance.unmount();
      await sleep(100);
      const cells = columns * process.stdout.rows;
      report(
        `  ${pad(`${columns}x${process.stdout.rows}`, 10)} ${pad(perFrame.toFixed(0), 8)} B/frame` +
          `   ${pad((perFrame / process.stdout.rows).toFixed(0), 5)} B/row` +
          `   ${pad((perFrame / cells).toFixed(2), 5)} B/cell`,
      );
    }
}

async function main() {
  const options = parseArgv(process.argv.slice(2));
  if (options.help) {
    report(HELP);
    return 0;
  }

  let ink;
  let react;
  const importStart = performance.now();
  try {
    ink = await import('ink');
    react = await import('react');
  } catch (error) {
    report(`tui-perf: ink/react not importable (${error.message}); run pnpm install`);
    return 2;
  }
  const importMs = performance.now() - importStart;

  let tui;
  let modelModule;
  try {
    tui = await import(path.join(repoRoot, 'dist/cli/dev-tui/app.js'));
    modelModule = await import(path.join(repoRoot, 'dist/cli/dev-tui/model.js'));
  } catch (error) {
    report(
      `tui-perf: cannot load dist/cli/dev-tui/* (${error.message}); run pnpm build first`,
    );
    return 2;
  }

  const tools = {
    tui,
    ink,
    react,
    createDevTuiModel: modelModule.createDevTuiModel,
  };

  report('');
  report(
    `ink ${installedRenderVersion()} · react ${react.version ?? '?'} · ` +
      `stdout isTTY=${String(process.stdout.isTTY ?? false)}`,
  );
  report(
    `import ink+react: ${importMs.toFixed(0)} ms ` +
      '(once per session, behind the seam dynamic import)',
  );
  if (process.stdout.isTTY !== true) {
    report('');
    report('WARNING: stdout is not a TTY, so the renderer may skip its');
    report('full-viewport path and the bytes/frame table is meaningless.');
    report('Re-run under a PTY:');
    report('  script -q /dev/null node tools/tui-perf.mjs');
  }

  await measureCpu(tools, options);
  await measureIo(tools, options);

  report('');
  report('Reading the tables:');
  report('  · CPU that barely moves as `lines` grows means the view model is');
  report('    windowed, so buffer size is not the cost driver.');
  report('  · In the byte table, compare the B/row column across widths: if it');
  report('    stays flat while B/cell falls, a frame is repainted per VIEWPORT');
  report('    ROW (its height), not per changed line. That is a property of the');
  report('    render layer, not of this repo: a taller terminal pays more for');
  report('    the same amount of news.');
  report('  · onRender counts frames the renderer actually painted, which can');
  report('    exceed --frames (mount and trailing frames are included).');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    report(`tui-perf: failed (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 2;
  });
