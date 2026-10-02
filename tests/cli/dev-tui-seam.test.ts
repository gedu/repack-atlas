// T4 seam fence + behavior lock for the dev TUI.
//
// (1) The rule-11 fence (AGENTS.md exception (b)): eslint has no ink/react
// rule, so THIS test is the fence. `src/cli/dev.ts` must never statically
// import `ink`, `react` or the ink render layer `dev-tui/app.js` — only
// dynamic `await import(...)` of those is allowed (and required to stay,
// or the fence would be satisfiable by deleting the mount). The statically
// imported `dev-tui/model.js` is allowed precisely because it is pure: (3)
// checks it carries no ink/react reference at all.
//
// (2) Behavior lock: the TUI gate never mounts in the test environment. A
// live no-interactive run (stdoutIsTTY false, the gate's distinguishing
// fact) on a temp copy of the fixture spawns the real stub bundlers and
// must render the PLAIN path: `[name]`-prefixed lines and no alt-screen
// bytes anywhere. Quit via `process.emit('SIGINT')` — the seam's own
// listener (registered before `start()`, the same one a human's Ctrl-C
// reaches) — exactly like tests/runner/dev-runner.test.ts drives sessions.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runDevCommand, type DevEnv } from '../../src/cli/dev.js';
import { copyTree, repoRoot } from './run-bin.js';
import { fakePrompts } from './fake-prompts.js';

const FIXTURE_WORKSPACE = path.join(repoRoot, 'fixtures', 'workspace');
const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('dev TUI seam: rule 11 static-import fence', () => {
  const devSource = readFileSync(
    path.join(repoRoot, 'src', 'cli', 'dev.ts'),
    'utf8'
  );

  // Static `import ... from '<spec>'` statements only (named, namespace,
  // default, type). Comments mention the specifiers in prose, so the regex
  // anchors on the `import` keyword at a line start.
  const escape = (text: string): string =>
    text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const staticImportFrom = (spec: string): RegExp =>
    new RegExp(`^\\s*import\\b[^;]*?from\\s+'${escape(spec)}'`, 'm');
  // The dynamic form mountDevTui() actually uses.
  const dynamicImportFrom = (spec: string): RegExp =>
    new RegExp(`await import\\('${escape(spec)}'\\)`);

  for (const spec of ['ink', 'react', './dev-tui/app.js', './dev-tui/wizard.js']) {
    it(`dev.ts has no static import of '${spec}'`, () => {
      assert.doesNotMatch(
        devSource,
        staticImportFrom(spec),
        `ink/react must stay behind dynamic imports (rule 11 exception (b)): '${spec}'`
      );
    });
    it(`dev.ts keeps the dynamic import of '${spec}'`, () => {
      assert.match(
        devSource,
        dynamicImportFrom(spec),
        `the lazy mount for '${spec}' must not be deleted — that would "pass" the fence by removing the TUI`
      );
    });
  }

  it('dev.ts statically imports only the pure model from dev-tui', () => {
    assert.match(
      devSource,
      /^\s*import\s*\{[^}]*createDevTuiModel[^}]*\}\s*from\s*'\.\/dev-tui\/model\.js'/m,
      'the seam may statically import the pure view-model'
    );
  });

  // G3 (weak but honest): crash-restore under a pty is disproportionate to
  // test here, so this only locks that BOTH fatal handler names are
  // registered with process.once AND removed again (registration without
  // removal would make clean exits unwinnable; removal without registration
  // would mean the guard silently vanished). The behavioral proof is the
  // manual terminal smoke: crash the TUI, the shell screen comes back.
  it('dev.ts registers and removes both crash handlers (G3)', () => {
    for (const name of ['uncaughtException', 'unhandledRejection']) {
      assert.match(
        devSource,
        new RegExp(`process\\.once\\('${name}'`),
        `the mounted-TUI crash guard must register 'process.once(${name})'`
      );
      assert.ok(
        (devSource.match(new RegExp(`removeListener\\('${name}'`, 'g')) ?? [])
          .length >= 2,
        `'${name}' must be removed both in the fatal path and on disarm`
      );
    }
    // The emergency teardown must include the mouse-tracking OFF decseq —
    // React effect cleanups never run on a crash, so the seam writes it.
    assert.match(
      devSource,
      /const MOUSE_TRACKING_OFF = '\\u001b\[\?1000l\\u001b\[\?1006l'/,
      'the crash path must disable mouse reporting (same bytes as app.tsx)'
    );
  });

  // G4 (static, honest): the banner must print on HUMAN paths only. Running
  // a real TTY session under test is out of scope, so this checks the
  // guard textually: the renderStartupBanner call sits inside an `if` whose
  // condition carries all three machine-path exclusions. A regex over the
  // source is weak (it cannot prove block structure), but the call appears
  // exactly once, and the condition line is captured directly above it.
  it('dev.ts gates the startup banner behind the human-TTY condition (G4)', () => {
    const call = /\brenderStartupBanner\(/.exec(devSource);
    assert.ok(call !== null, 'the seam must render the startup banner');
    const before = devSource.slice(0, call?.index ?? 0);
    const guard = /if\s*\(([^)]*)\)\s*\{[^{}]*$/s.exec(before);
    assert.ok(guard !== null, 'the banner call must sit directly inside an if block');
    const condition = guard[1] ?? '';
    assert.match(condition, /!json/, 'the --json stream must never print the banner');
    assert.match(condition, /!ci/, '--ci must never print the banner');
    assert.match(condition, /stdoutIsTTY/, 'non-TTY stdout must never print the banner');
  });

  // banner.ts is statically imported by dev.ts, so it must hold the same
  // purity promise model.ts holds (no ink/react, no io) — otherwise the
  // static import would leak render-layer weight onto machine paths.
  it('banner.ts stays pure: no ink/react import, static or dynamic', () => {
    const bannerSource = readFileSync(
      path.join(repoRoot, 'src', 'cli', 'dev-tui', 'banner.ts'),
      'utf8'
    );
    assert.doesNotMatch(bannerSource, /^\s*import\b[^;]*?from\s+'(ink|react)'/m);
    assert.doesNotMatch(bannerSource, /\bimport\('(ink|react)'\)/);
  });

  // S1 (static, honest): ink refs stdin but NEVER resumes it, and a paused
  // stream never fires 'readable' — so the dashboard MUST resume stdin
  // before render() or the whole keymap sits deaf (the real-pty smoke that
  // motivated this: zero ink input events after the wizard handed over,
  // arrows/j/k/q all dead). A regex is weak, but it locks the fix in place
  // at exactly one spot: between the alt-screen enter and render().
  it('dev.ts resumes stdin before the dashboard render (S1)', () => {
    const enter = devSource.indexOf('ALT_SCREEN_ENTER)');
    const render = devSource.indexOf(
      'const instance = render(',
      enter
    );
    assert.ok(enter > 0 && render > enter, 'mountDevTui must write the alt screen then render');
    const between = devSource.slice(enter, render);
    assert.match(
      between,
      /process\.stdin\.resume\(\)/,
      'mountDevTui must resume the wizard-paused stdin before ink renders'
    );
    // And the teardown parks it again, or the resumed TTY handle would keep
    // the process alive after the session ends.
    assert.match(
      devSource.slice(render),
      /else if \(tuiWillMount\) \{[\s\S]{0,400}?process\.stdin\.pause\(\);/,
      'the finally must park the resumed stdin again'
    );
  });

  it('model.ts stays pure: no ink/react import, static or dynamic', () => {
    const modelSource = readFileSync(
      path.join(repoRoot, 'src', 'cli', 'dev-tui', 'model.ts'),
      'utf8'
    );
    assert.doesNotMatch(modelSource, /^\s*import\b[^;]*?from\s+'(ink|react)'/m);
    assert.doesNotMatch(modelSource, /\bimport\('(ink|react)'\)/);
    // Type-only imports from core/runner are the purity contract (the header
    // comment is the only other place these words may appear).
    const runtimeImports = [
      ...modelSource.matchAll(/^import\s+(?!type\s)[^;]*;/gm),
    ];
    assert.deepEqual(
      runtimeImports.map((match) => match[0]),
      [],
      'model.ts may hold `import type` statements only'
    );
  });
});

describe('dev TUI gate: plain path on a machine session', () => {
  it('live --no-interactive run renders plain [name] lines, zero alt-screen bytes', async () => {
    // Same port policy as tests/runner/dev-runner.test.ts: a temp copy of
    // the fixture whose remote ports (8082/8083 for its other readers) are
    // rewritten to free ones, host pinned with --port.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-tui-gate-'));
    tmpDirs.push(dir);
    await copyTree(FIXTURE_WORKSPACE, dir);
    const config = JSON.parse(
      readFileSync(path.join(dir, 'repack-federation.json'), 'utf8')
    ) as {
      host: Record<string, unknown>;
      remotes: { mini_auth: Record<string, unknown>; mini_store: Record<string, unknown> };
    };
    const hostPort = await freePort();
    config.remotes.mini_auth.port = await freePort();
    config.remotes.mini_store.port = await freePort();
    writeFileSync(path.join(dir, 'repack-federation.json'), JSON.stringify(config));

    const prompts = fakePrompts([]);
    let created = 0;
    const env: DevEnv = {
      // Machine session: not a human at a TTY. In the test environment
      // process.stdin.isTTY is false as well, so the TUI gate
      // (`!ci && !json && stdin.isTTY && env.stdoutIsTTY`) cannot mount.
      stdoutIsTTY: false,
      stdinIsTTY: false,
      createPrompts: async () => {
        created += 1;
        return prompts;
      },
    };

    const out: string[] = [];
    let err = '';
    // The supervisor logs every child stdout line, so `[app] ready` for all
    // three apps proves the plain log path is live and complete. The seam's
    // SIGINT listener exists by then (registered before `start()`, and no
    // child output can precede it).
    let observe = (_line: string): void => {
      /* replaced by the promise body below */
    };
    const allReady = new Promise<void>((resolve, reject) => {
      const seen = new Set<string>();
      const timer = setTimeout(
        () => reject(new Error(`ready logs never arrived, saw: ${[...seen]}`)),
        20_000
      );
      observe = (line: string): void => {
        const match = /^\[(host|mini_auth|mini_store)\] ready$/.exec(line);
        if (match?.[1] !== undefined) seen.add(match[1]);
        if (seen.size === 3) {
          clearTimeout(timer);
          resolve();
        }
      };
    });

    const run = runDevCommand(
      [
        '--workspace',
        dir,
        '--no-interactive',
        '--no-launch',
        '--port',
        String(hostPort),
        '--studio-port',
        '0',
      ],
      {
        writeOut: (text) => {
          out.push(text);
          for (const line of text.split('\n')) observe(line);
        },
        writeErr: (text) => void (err += `${text}\n`),
      },
      env
    );

    await allReady;
    process.emit('SIGINT');
    const code = await run;

    assert.equal(code, 0, err);
    assert.equal(created, 0, 'the wizard must not run for --no-interactive');
    assert.equal(prompts.asked.length, 0);
    const stdout = out.join('\n');
    // Plain rendering intact: prefixed child logs + the supervising line.
    assert.match(stdout, /^\[host\] ready$/m);
    assert.match(stdout, /^\[mini_auth\] ready$/m);
    assert.match(stdout, /^\[mini_store\] ready$/m);
    assert.match(stdout, /^dev: supervising 3 app\(s\)/m);
    // The TUI never mounted: no alt-screen/cursor escape bytes, no
    // degradation warning, on either stream.
    assert.ok(!stdout.includes('\u001b'), `ESC byte leaked into stdout:\n${stdout}`);
    assert.ok(!err.includes('\u001b'), `ESC byte leaked into stderr:\n${err}`);
    assert.doesNotMatch(err, /TUI unavailable/);
  });
});

// ---------------------------------------------------------------------------
// G5 "wizard-in-TUI": which PromptPort the wizard block gets.
//
// The two branches differ on ONE fact: `process.stdin.isTTY` (the dashboard's
// condition term the wizard gate does not share). Everything else the wizard
// needs (env.stdoutIsTTY/env.stdinIsTTY) is true in both, so:
//   - process.stdin.isTTY true  + human env  → the ink port (dynamic import)
//   - process.stdin.isTTY false + human env  → env.createPrompts, byte-identical
// Machine flags (--json/--ci/--no-interactive) never reach either branch, which
// the gate test above already locks; here they only prove the ink port is not
// built behind their back.
// ---------------------------------------------------------------------------

/** Minimal fake streams for the ink wizard port (ink-testing-library shape). */
class FakeWizardStdout extends EventEmitter {
  columns = 100;
  rows = 24;
  isTTY = false;
  readonly chunks: string[] = [];
  readonly setEncoding = (): void => undefined;
  write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };
  get text(): string {
    return this.chunks.join('');
  }
}

class FakeWizardStdin extends EventEmitter {
  isTTY = true;
  rawMode = false;
  paused = false;
  private pending: string | null = null;
  readonly setEncoding = (): void => undefined;
  setRawMode = (enabled: boolean): void => {
    this.rawMode = enabled;
  };
  resume = (): void => {
    this.paused = false;
  };
  pause = (): void => {
    this.paused = true;
  };
  ref = (): void => undefined;
  unref = (): void => undefined;
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

const tick = (ms = 25): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a condition the wizard's session establishes (the plan load ahead of
 * the first question spawns CLI probes, so a fixed sleep is a race). */
async function until(
  label: string,
  condition: () => boolean,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

/** `process.stdin.isTTY` is inherited from tty.ReadStream, so an override is an
 * OWN property and the restore is a DELETE — a saved descriptor would be
 * undefined and the stub would leak into the next test. */
function stubStdinIsTTY(value: boolean): () => void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    delete (process.stdin as { isTTY?: boolean }).isTTY;
  };
}

describe('G5 wizard prompt routing', () => {
  it('routes the wizard to the ink port when the TUI condition is live', async () => {
    // The one fact that flips the branch: the dashboard's stdin term.
    const restoreStdinTTY = stubStdinIsTTY(true);
    const stdin = new FakeWizardStdin();
    const stdout = new FakeWizardStdout();
    try {
      const prompts = fakePrompts([]);
      let created = 0;
      const env: DevEnv = {
        stdoutIsTTY: true,
        stdinIsTTY: true,
        createPrompts: async () => {
          created += 1;
          return prompts;
        },
        promptStreams: {
          stdin: stdin as unknown as NodeJS.ReadStream,
          stdout: stdout as unknown as NodeJS.WriteStream,
        },
      };
      let err = '';
      const running = runDevCommand(
        ['--workspace', FIXTURE_WORKSPACE, '--dry-run'],
        { writeOut: () => undefined, writeErr: (text) => void (err += `${text}\n`) },
        env
      );
      // The ink session takes raw mode for the first question, then Ctrl-C
      // walks away (the wizard's clean exit-0 cancel).
      await until('the ink wizard to own raw mode', () => stdin.rawMode);
      // NO stdout assertion for the live question here: ink buffers
      // interactive frames on a TTY stdout through log-update, but under
      // `is-in-ci` (CI=true in every runner) it skips the per-frame writes
      // and flushes only the LAST frame at unmount (ink/ink.js onRender CI
      // branch + unmount's lastOutput write) — the question text is simply
      // never on stdout mid-session in that mode. The ink path this test
      // proves is the ROUTING: raw mode taken (only an ink session does
      // that on these streams), the plain port never created, and the
      // cursor re-show written at teardown. Question RENDERING is proven
      // frame-by-frame by tests/cli/dev-tui-wizard-port.test.ts (non-TTY
      // stdout, where ink writes plain output in every mode).
      if (
        !['CI', 'CONTINUOUS_INTEGRATION'].some(
          (key) =>
            key in process.env &&
            process.env[key] !== '0' &&
            process.env[key] !== 'false'
        )
      ) {
        // Only true outside ink's CI mode, where ink paints every frame:
        assert.match(
          stdout.text,
          /Which remotes to run\?/,
          'the question renders through the ink session'
        );
      }
      stdin.send('\u0003'); // ETX = Ctrl-C in raw mode
      const code = await running;

      assert.equal(code, 0, err);
      assert.equal(created, 0, 'the clack/readline port must NOT be created');
      assert.equal(prompts.asked.length, 0);
      assert.equal(stdin.rawMode, false, 'close() must hand raw mode back');
      assert.equal(stdin.paused, true, 'stdin must end paused for the dashboard');
      assert.match(stdout.text, /\[\?25h/, 'the cursor must be shown again');
      assert.doesNotMatch(err, /wizard TUI prompts unavailable/);
    } finally {
      restoreStdinTTY();
    }
  });

  it('keeps env.createPrompts when the wizard runs without a dashboard (no TTY stdin)', async () => {
    // Same human env, `process.stdin.isTTY` false (the real case: piped stdin,
    // TTY stdout). The wizard still asks — through the plain port, exactly as
    // before G5.
    // Belt over the restore above: this case's premise IS a non-TTY stdin.
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    assert.equal(
      Boolean(process.stdin.isTTY),
      false,
      'precondition: the test runner has no TTY stdin'
    );
    const hostPort = await freePort();
    const prompts = fakePrompts([
      ['mini_store'],
      'android',
      false,
      true, // host port kept
      true, // mini_store port kept
    ]);
    let created = 0;
    const stdin = new FakeWizardStdin();
    const stdout = new FakeWizardStdout();
    const env: DevEnv = {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      createPrompts: async () => {
        created += 1;
        return prompts;
      },
      // Injected anyway: the TUI branch must not be taken, so these streams
      // stay untouched.
      promptStreams: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    };
    let out = '';
    const code = await runDevCommand(
      ['--workspace', FIXTURE_WORKSPACE, '--dry-run', '--port', String(hostPort)],
      {
        writeOut: (text) => void (out += `${text}\n`),
        writeErr: () => undefined,
      },
      env
    );
    assert.equal(code, 0);
    assert.equal(created, 1, 'the plain port is the one the wizard used');
    assert.equal(prompts.closed, 1);
    assert.equal(stdin.rawMode, false, 'the ink session never mounted');
    assert.equal(stdout.chunks.length, 0);
    assert.match(out, /^mini_store\s+remote/m);
  });

  it('builds no ink port on machine paths (--json/--ci/--no-interactive)', async () => {
    const hostPort = String(await freePort());
    for (const flag of ['--json', '--ci', '--no-interactive']) {
      const stdin = new FakeWizardStdin();
      const stdout = new FakeWizardStdout();
      const prompts = fakePrompts([]);
      let created = 0;
      const env: DevEnv = {
        stdoutIsTTY: true,
        stdinIsTTY: true,
        createPrompts: async () => {
          created += 1;
          return prompts;
        },
        promptStreams: {
          stdin: stdin as unknown as NodeJS.ReadStream,
          stdout: stdout as unknown as NodeJS.WriteStream,
        },
      };
      const code = await runDevCommand(
        [
          '--workspace',
          FIXTURE_WORKSPACE,
          '--dry-run',
          '--port',
          hostPort,
          flag,
        ],
        { writeOut: () => undefined, writeErr: () => undefined },
        env
      );
      assert.equal(code, 0, flag);
      assert.equal(created, 0, `${flag}: no prompt port at all`);
      assert.equal(stdin.rawMode, false, `${flag}: ink never touched stdin`);
      assert.equal(stdout.chunks.length, 0, `${flag}: ink never wrote a frame`);
    }
  });

  // Render-layer honesty (same rule as the dashboard mount): if the ink module
  // cannot load, the wizard still asks the same questions through the plain
  // port — it never dies with the renderer.
  it('degrades to env.createPrompts when the wizard module fails to load', async () => {
    const source = readFileSync(
      path.join(repoRoot, 'src', 'cli', 'dev.ts'),
      'utf8'
    );
    const fallback =
      /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}?using plain prompts[\s\S]{0,200}?return env\.createPrompts\(\);/;
    assert.match(
      source,
      fallback,
      'the ink-port branch must catch and fall back to env.createPrompts'
    );
  });
});
