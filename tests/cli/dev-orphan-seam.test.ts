// C seam tests (ODD dev-port-conflict-warn-kill): the human orphan flow in
// `runDevCommand` (src/cli/dev.ts), driven in-process the way
// tests/cli/dev-tui-seam.test.ts drives the seam — fake prompts through
// `env.createPrompts`, a fake ProcessRunner (+PortOwnership) through the new
// `env.createProcessRunner` injection, a throwaway workspace whose apps
// declare `root` (so the conflict carries appDirs) AND a verbatim `command`
// (so the retry's session spawns through the FAKE runner only and no
// toolchain resolution runs).
//
// Level achieved: FULL behavioral coverage of the gate + outcomes, not just
// the static-fence level. The precondition locks below (non-TTY process
// stdin) keep the wizard/ink/raw-mode surfaces out of the run — exactly the
// dev-tui-seam G5 discipline — while the human GATE of the orphan flow
// (env.stdoutIsTTY/env.stdinIsTTY + no --json/--ci) is genuinely exercised:
// resolveDevPlan conflict -> gate -> offerOrphanKills over the fake
// ownership/prompts -> the ONE retry -> a live supervised session -> clean
// exit through the seam's own SIGINT listener.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type {
  ProcessHandle,
  ProcessRunner,
  SpawnSpec,
} from '../../src/core/index.js';
import {
  createNodeProcessRunner,
  type NodeProcessRunner,
} from '../../src/adapters/index.js';
import { PORT_CONFLICT_HINT, type PortOwnerInfo } from '../../src/runner/ports.js';
import { runDevCommand, type DevEnv } from '../../src/cli/dev.js';
import { fakePrompts } from './fake-prompts.js';

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

// Fake-only port numbers: every busy/free answer comes from the fake runner
// — nothing binds or connects, so the real world's state of these ports is
// irrelevant. Far from ephemeral ranges for log legibility.
const PORT_HOST = 39_001;
const PORT_A = 39_002;
const PID_HOST = 410_001;
const PID_A = 410_002;

/** The command an orphaned Atlas dev server of THIS workspace would show. */
const orphanCommand = (appRoot: string, port: number): string =>
  `node ${appRoot}/node_modules/react-native/cli.js start --port ${port}`;

interface FakeSeamRunner extends NodeProcessRunner {
  /** pids terminate() signalled, in order. */
  terminated(): number[];
  /** ports portOwner() was asked about, in order. */
  ownerAsks(): number[];
}

/**
 * Fake OS side. A `busy` port answers busy until its owner pid is
 * terminated; `start` (the supervisor's spawn after a successful retry)
 * re-busyies the child's ATLAS_APP_PORT so readiness lands, and its handle
 * frees the port on killTree like the real adapter's teardown.
 */
function fakeSeamRunner(options: {
  busy: Record<number, PortOwnerInfo | null>;
}): FakeSeamRunner {
  const terminated: number[] = [];
  const ownerAsks: number[] = [];
  // port -> the owner pid whose death frees it (null: only killTree frees).
  const busyPorts = new Map<number, number | null>();
  for (const [port, owner] of Object.entries(options.busy)) {
    busyPorts.set(Number(port), owner?.pid ?? null);
  }
  const handleFor = (port: number | undefined): ProcessHandle => {
    let finish!: (r: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        finish = resolve;
      }
    );
    return {
      pid: 770_000 + (port ?? 0),
      subscribeToStdout: () => () => {},
      subscribeToStderr: () => () => {},
      waitForExit: () => exited,
      signal: () => {},
      killTree: async () => {
        if (port !== undefined) busyPorts.delete(port);
        finish({ code: null, signal: 'SIGINT' });
      },
    };
  };
  const runner: ProcessRunner = {
    start(spec: SpawnSpec): ProcessHandle {
      const raw = Number(spec.env?.['ATLAS_APP_PORT']);
      const port = Number.isInteger(raw) ? raw : undefined;
      // The spawned server answers its port: readiness must see it busy.
      if (port !== undefined) busyPorts.set(port, null);
      return handleFor(port);
    },
    async isPortBusy(port: number): Promise<boolean> {
      return busyPorts.has(port);
    },
    async findFreePort(): Promise<number> {
      throw new Error('the fixture declares every port');
    },
  };
  return {
    ...runner,
    terminated: () => [...terminated],
    ownerAsks: () => [...ownerAsks],
    async portOwner(port: number): Promise<PortOwnerInfo | null> {
      ownerAsks.push(port);
      return options.busy[port] ?? null;
    },
    terminate(pid: number): boolean {
      terminated.push(pid);
      for (const [port, ownerPid] of busyPorts) {
        if (ownerPid === pid) busyPorts.delete(port);
      }
      return true;
    },
  };
}

/**
 * Throwaway workspace: host + one remote, each declaring a `root` (feeds the
 * conflict's appDirs) and a verbatim `command` (only the fake runner ever
 * sees the spawn).
 */
function seamWorkspace(): {
  dir: string;
  appDirs: Record<'host' | 'a', string>;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-orphan-seam-'));
  cleanupDirs.push(dir);
  const appDirs = {
    host: path.join(dir, 'apps', 'host'),
    a: path.join(dir, 'apps', 'a'),
  };
  for (const root of Object.values(appDirs)) {
    mkdirSync(root, { recursive: true });
  }
  writeFileSync(
    path.join(dir, 'repack-federation.json'),
    JSON.stringify({
      host: {
        manifest: './h.json',
        root: './apps/host',
        port: PORT_HOST,
        command: 'true',
      },
      remotes: {
        a: {
          manifest: './a.json',
          root: './apps/a',
          port: PORT_A,
          command: 'true',
        },
      },
    })
  );
  return { dir, appDirs };
}

/**
 * Lock the environment premise (same discipline as the G5 seam tests):
 * `process.stdin.isTTY` must be false, or the ink port and the raw-mode
 * key path would join the run and change what this file proves.
 */
function requireNonTtyStdin(): void {
  delete (process.stdin as { isTTY?: boolean }).isTTY;
  assert.equal(
    Boolean(process.stdin.isTTY),
    false,
    'precondition: the test runner has no TTY stdin (only then is the human gate injectable through env alone)'
  );
}

interface SeamRun {
  code: number;
  out: string;
  err: string;
  prompts: ReturnType<typeof fakePrompts>;
  runner: FakeSeamRunner;
  workspace: ReturnType<typeof seamWorkspace>;
}

/**
 * Run `dev` to its outcome on a PRE-BUILT throwaway workspace (the canned
 * busy owners must name that dir's app paths). `untilLine` (when given)
 * marks the live session established: the run is then quit via
 * `process.emit('SIGINT')` — the seam's own listener, the same one a human's
 * Ctrl-C reaches — exactly like tests/cli/dev-tui-seam.test.ts.
 */
async function runSeam(
  workspace: ReturnType<typeof seamWorkspace>,
  options: {
    args: string[];
    busy: Record<number, PortOwnerInfo | null>;
    script: Array<boolean | 'cancel'>;
    untilLine?: RegExp;
  }
): Promise<SeamRun> {
  requireNonTtyStdin();
  const runner = fakeSeamRunner({ busy: options.busy });
  const prompts = fakePrompts(options.script);
  let out = '';
  let err = '';
  const env: DevEnv = {
    // Human at a TTY per the injectable flags; the wizard is skipped via
    // --apps, and the ink/raw-mode paths stay out on the stdin premise.
    stdoutIsTTY: true,
    stdinIsTTY: true,
    createPrompts: async () => prompts,
    createProcessRunner: () => runner,
  };
  let quitSent = false;
  const observe = (text: string): void => {
    if (options.untilLine === undefined || quitSent) return;
    if (options.untilLine.test(text)) {
      quitSent = true;
      // The supervised session is live: Ctrl-C equivalent, ordered shutdown.
      setTimeout(() => process.emit('SIGINT'), 0);
    }
  };
  const code = await runDevCommand(
    ['--workspace', workspace.dir, '--no-studio', ...options.args],
    {
      writeOut: (text) => {
        out += `${text}\n`;
        observe(text);
      },
      writeErr: (text) => {
        err += `${text}\n`;
        observe(text);
      },
    },
    env
  );
  return { code, out, err, prompts, runner, workspace };
}

const CONFLICT_LINES = [
  `dev: port ${PORT_HOST} declared by host is already busy`,
  `dev: port ${PORT_A} declared by a is already busy`,
  `dev: ${PORT_CONFLICT_HINT}`,
];

/** Every busy owner is a workspace orphan of this very dir. */
function orphanedBusy(workspace: ReturnType<typeof seamWorkspace>) {
  return {
    [PORT_HOST]: {
      pid: PID_HOST,
      ppid: 1,
      command: orphanCommand(workspace.appDirs.host, PORT_HOST),
    } satisfies PortOwnerInfo,
    [PORT_A]: {
      pid: PID_A,
      ppid: 1,
      command: orphanCommand(workspace.appDirs.a, PORT_A),
    } satisfies PortOwnerInfo,
  };
}

const APPS = ['--apps', 'host,a'];

describe('dev orphan-kill seam (human path, dev.ts)', () => {
  it('kills confirmed workspace orphans, notes each kill, and retries into a live session', async () => {
    const workspace = seamWorkspace();
    const { code, err, out, prompts, runner } = await runSeam(workspace, {
      args: APPS,
      busy: orphanedBusy(workspace),
      script: [true, true],
      // Quit once the RETRIED plan actually supervised both fake apps.
      untilLine: /dev: a → ready/,
    });

    assert.equal(code, 0, err);
    assert.deepEqual(runner.terminated(), [PID_HOST, PID_A]);
    assert.match(
      err,
      new RegExp(
        `dev: killed orphaned dev server on port ${PORT_HOST} \\(pid ${PID_HOST}\\)`
      )
    );
    assert.match(
      err,
      new RegExp(
        `dev: killed orphaned dev server on port ${PORT_A} \\(pid ${PID_A}\\)`
      )
    );
    // The retry actually PROCEEDED: the supervising line only prints after a
    // successful plan — unreachable here before this feature existed.
    assert.match(out, /dev: supervising 2 app\(s\)/);
    assert.match(out, /dev: host → ready/);
    assert.match(out, /dev: a → ready/);
    // The kill offers went through the PromptPort seam, one per port, and
    // the port was closed again.
    assert.deepEqual(
      prompts.asked.map((q) => /^confirm: Port (\d+)/.exec(q)?.[1]),
      [String(PORT_HOST), String(PORT_A)]
    );
    assert.ok(
      prompts.asked.every((q) => q.endsWith('. Kill it?')),
      `asked: ${prompts.asked}`
    );
    assert.equal(prompts.closed, 1, 'the orphan-flow prompt port was closed');
  });

  it('a declined kill keeps the OLD error path byte-for-byte: conflict lines, exit 1, no retry', async () => {
    const workspace = seamWorkspace();
    const result = await runSeam(workspace, {
      args: APPS,
      busy: orphanedBusy(workspace),
      script: [false], // decline the first offer
    });

    assert.equal(result.code, 1, result.err);
    assert.deepEqual(result.runner.terminated(), [], 'a decline signals nothing');
    // stderr is exactly the pre-feature fatal lines (the banner, if any, is
    // stdout-only; --no-studio keeps the studio path out of every branch).
    assert.deepEqual(
      result.err.split('\n').filter((line) => line !== ''),
      CONFLICT_LINES
    );
    assert.doesNotMatch(result.err, /killed orphaned/);
    assert.equal(
      result.prompts.closed,
      1,
      'the offer port closed even on the decline path'
    );
  });

  for (const machineFlag of ['--json', '--ci']) {
    it(`${machineFlag}: never prompts, never probes owners, byte-identical conflict output, exit 1`, async () => {
      const workspace = seamWorkspace();
      const result = await runSeam(workspace, {
        args: [...APPS, machineFlag],
        busy: orphanedBusy(workspace),
        script: [], // ANY prompt would throw unscripted
      });

      assert.equal(result.code, 1, result.err);
      assert.deepEqual(
        result.runner.ownerAsks(),
        [],
        `${machineFlag}: the owner is never probed`
      );
      assert.deepEqual(result.runner.terminated(), []);
      assert.equal(result.prompts.asked.length, 0, `${machineFlag}: nothing asked`);
      assert.deepEqual(
        result.err.split('\n').filter((line) => line !== ''),
        CONFLICT_LINES,
        `${machineFlag}: the conflict report stays byte-identical`
      );
    });
  }

  it('an owner that is NOT a workspace orphan gets no prompt and the old error path', async () => {
    const workspace = seamWorkspace();
    const busy = orphanedBusy(workspace);
    const result = await runSeam(workspace, {
      args: APPS,
      busy: {
        // Live sibling (ppid !== 1): not an orphan -> no offer at all, and
        // the all-or-nothing rule keeps the OTHER orphan unasked too.
        [PORT_HOST]: { ...busy[PORT_HOST], ppid: 42 },
        [PORT_A]: busy[PORT_A],
      },
      script: [], // any prompt would throw unscripted
    });

    assert.equal(result.code, 1, result.err);
    assert.equal(result.prompts.asked.length, 0, 'no offer for a non-orphan set');
    assert.deepEqual(result.runner.terminated(), []);
    assert.deepEqual(
      result.err.split('\n').filter((line) => line !== ''),
      CONFLICT_LINES
    );
  });
});


describe('DevEnv.createProcessRunner seam', () => {
  it('the real node runner still composes the ownership capability when nothing is injected', () => {
    // The injectable must be an ADDITIVE test seam, not the production path:
    // without env.createProcessRunner the seam uses the real composed runner.
    const realRunner = createNodeProcessRunner();
    assert.equal(typeof realRunner.portOwner, 'function');
    assert.equal(typeof realRunner.terminate, 'function');
    assert.equal(typeof realRunner.isPortBusy, 'function');
  });

  it('the wizard path wires the busy/owner probe through this same runner (A)', async () => {
    // The dev-wizard unit tests prove what a probe DOES to the question;
    // this proves dev.ts actually HANDS it one: the human wizard (no --apps,
    // injectable TTY env, fake prompt port) asks the host-port question with
    // the "(in use: …)" note built from the fake runner's busy + owner
    // answers. (The temp path is long enough to hit the formatOwnerCommand
    // cap, so the note is only asserted to NAME the owner, not echo argv.)
    requireNonTtyStdin();
    const workspace = seamWorkspace();
    const runner = fakeSeamRunner({
      busy: {
        [PORT_HOST]: {
          pid: PID_HOST,
          ppid: 1,
          command: orphanCommand(workspace.appDirs.host, PORT_HOST),
        },
      },
    });
    // remotes multiselect (a), platform, launch-no, host port kept, a kept.
    const prompts = fakePrompts([['a'], 'ios', false, true, true]);
    await runDevCommand(
      ['--workspace', workspace.dir, '--dry-run', '--no-studio'],
      { writeOut: () => undefined, writeErr: () => undefined },
      {
        stdoutIsTTY: true,
        stdinIsTTY: true,
        createPrompts: async () => prompts,
        createProcessRunner: () => runner,
      }
    );
    const hostQuestion = prompts.asked.find((q) =>
      q.includes(`Use port ${PORT_HOST} for host`)
    );
    assert.ok(
      hostQuestion !== undefined,
      `the host port question was asked, saw: ${prompts.asked}`
    );
    assert.match(
      hostQuestion!,
      // The middle-eliding formatter drops the redundant leading `node ` on an
      // over-cap line and keeps the tail, so the surviving evidence that the
      // probe worked is the owner's own argv tail, not the leading `node `.
      /\(in use: .*cli\.js start --port /,
      `dev.ts must hand the wizard a working probe, got: ${hostQuestion}`
    );
  });
});
