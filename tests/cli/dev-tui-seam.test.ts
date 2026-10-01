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

  for (const spec of ['ink', 'react', './dev-tui/app.js']) {
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
