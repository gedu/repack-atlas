// Supervisor unit tests over a fake ProcessRunner: the one-shot (launch)
// child must stay supervised whatever its reporting hook does. Plus the
// resolveDevPlan conflict-shape contract (ODD dev-port-conflict-warn-kill)
// over real adapters on a throwaway config dir: the human orphan flow keys
// on exactly the busyPorts/appDirs fields a conflict carries.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createManifestSource,
  createNodeProjectFs,
  createReactNativeCliResolver,
  createWorkspaceConfigReader,
} from '../../src/adapters/index.js';
import type {
  ProcessHandle,
  ProcessRunner,
  SpawnSpec,
} from '../../src/core/index.js';
import {
  createDevSupervisor,
  type DevAppPlan,
  type DevPlanResult,
  resolveDevPlan,
  type OneShotEvent,
  type OneShotSpec,
} from '../../src/runner/supervisor.js';

const SPEC: OneShotSpec = { file: 'rn', args: ['run-ios'], cwd: '/ws' };

interface FakeChild {
  handle: ProcessHandle;
  exit(result: { code: number | null; signal: string | null }): void;
  killed(): boolean;
  /** Bytes pushed through the optional `writeStdin` (F12), in order. */
  written(): string[];
}

function fakeChild(options: { writableStdin?: boolean } = {}): FakeChild {
  let finish!: (r: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      finish = resolve;
    }
  );
  let killed = false;
  const written: string[] = [];
  const canWrite = options.writableStdin === true;
  return {
    handle: {
      pid: 4242,
      subscribeToStdout: () => () => {},
      subscribeToStderr: () => () => {},
      waitForExit: () => exited,
      signal: () => {},
      killTree: async () => {
        killed = true;
        finish({ code: null, signal: 'SIGINT' });
      },
      ...(canWrite
        ? {
            writeStdin: (data: string) => {
              if (killed) return false; // dead child: nothing received
              written.push(data);
              return true;
            },
          }
        : {}),
    },
    exit: finish,
    killed: () => killed,
    written: () => written,
  };
}

function runnerFor(start: (spec: SpawnSpec) => ProcessHandle): ProcessRunner {
  return {
    start,
    isPortBusy: async () => false,
    findFreePort: async () => 50_000,
  };
}

function supervisorWith(
  processRunner: ProcessRunner,
  onOneShot: (name: string, event: OneShotEvent) => void
) {
  return createDevSupervisor({
    plan: {
      ok: true,
      configDir: '/ws',
      entries: [],
      apps: [],
      skipped: [],
      warnings: [],
      reassignments: [],
    },
    processRunner,
    onLog: () => {},
    onStatus: () => {},
    onOneShot,
  });
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('spawnOneShot', () => {
  it('reports a child that cannot be spawned as spawn-failed, not as a fake exit', () => {
    const events: OneShotEvent[] = [];
    const supervisor = supervisorWith(
      runnerFor(() => {
        throw new Error('ENOENT');
      }),
      (_name, event) => events.push(event)
    );
    supervisor.spawnOneShot('launch', SPEC);
    assert.deepEqual(events, [{ status: 'spawn-failed' }]);
  });

  it('maps the runner\'s async spawn-error exit to spawn-failed too', async () => {
    const child = fakeChild();
    const events: OneShotEvent[] = [];
    const supervisor = supervisorWith(runnerFor(() => child.handle), (_n, e) =>
      events.push(e)
    );
    supervisor.spawnOneShot('launch', SPEC);
    child.exit({ code: null, signal: 'spawn-error' });
    await tick();
    assert.deepEqual(events, [
      { status: 'started', pid: 4242 },
      { status: 'spawn-failed' },
    ]);
  });

  it('a rejecting waitForExit is reported as an exit with no code or signal', async () => {
    const child = fakeChild();
    const rejecting: ProcessHandle = {
      ...child.handle,
      waitForExit: () => Promise.reject(new Error('port broke its contract')),
    };
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const events: OneShotEvent[] = [];
      const supervisor = supervisorWith(runnerFor(() => rejecting), (_n, e) =>
        events.push(e)
      );
      supervisor.spawnOneShot('launch', SPEC);
      await tick();
      await tick();
      assert.deepEqual(events, [
        { status: 'started', pid: 4242 },
        { status: 'exited', code: null, signal: null },
      ]);
      assert.deepEqual(rejections, []);
      // The child may still be running: it stays tracked and shutdown kills it.
      await supervisor.shutdown();
      assert.equal(child.killed(), true);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('a throwing hook on start does not crash and the child stays supervised', async () => {
    const child = fakeChild();
    const seen: OneShotEvent[] = [];
    const supervisor = supervisorWith(runnerFor(() => child.handle), (_n, e) => {
      seen.push(e);
      throw new Error('hook exploded');
    });
    assert.doesNotThrow(() => supervisor.spawnOneShot('launch', SPEC));
    // Still tracked: shutdown reaches it.
    await supervisor.shutdown();
    assert.equal(child.killed(), true);
    assert.deepEqual(seen, [{ status: 'started', pid: 4242 }]);
  });

  it('a throwing hook on exit is contained (no unhandled rejection)', async () => {
    const child = fakeChild();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const events: OneShotEvent[] = [];
      const supervisor = supervisorWith(runnerFor(() => child.handle), (_n, e) => {
        events.push(e);
        if (e.status === 'exited') throw new Error('hook exploded');
      });
      supervisor.spawnOneShot('launch', SPEC);
      child.exit({ code: 1, signal: null });
      await tick();
      await tick();
      assert.deepEqual(events.at(-1), { status: 'exited', code: 1, signal: null });
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveDevPlan: the additive conflict shape the human orphan flow consumes
// ---------------------------------------------------------------------------

const conflictDirs: string[] = [];
after(() => {
  for (const dir of conflictDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway config dir: `host` declares `root` AND a `command` (so no
 * toolchain resolution runs yet the entry still carries an app dir), the
 * remote declares only a command (a command app's cwd proves nothing about a
 * port owner, so it must NOT seed appDirs). `busy` ports answer busy.
 */
async function conflictPlan(busy: number[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-conflict-'));
  conflictDirs.push(dir);
  const appRoot = path.join(dir, 'apps', 'host');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    path.join(dir, 'repack-federation.json'),
    JSON.stringify({
      host: {
        manifest: './h.json',
        root: './apps/host',
        port: busy[0],
        command: 'true',
      },
      remotes: {
        a: { manifest: './a.json', port: busy[1], command: 'true' },
      },
    })
  );
  const fs = createNodeProjectFs();
  const result = await resolveDevPlan({
    workspaceDir: dir,
    configReader: createWorkspaceConfigReader(fs),
    manifestSource: createManifestSource(fs),
    reactNativeCli: createReactNativeCliResolver(),
    fs,
    processRunner: {
      start: () => {
        throw new Error('the plan phase never spawns');
      },
      isPortBusy: async (port: number) => busy.includes(port),
      findFreePort: async () => 50_000,
    },
    autoPorts: false,
  });
  return { dir, result };
}

describe('resolveDevPlan conflict shape (orphan-flow input)', () => {
  it('a busy-port conflict carries busyPorts in plan order and appDirs of root/argv apps only', async () => {
    const { dir, result } = await conflictPlan([8081, 8082]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.portConflict === true);
    assert.deepEqual(result.busyPorts, [8081, 8082]);
    assert.deepEqual(
      result.appDirs,
      [path.join(dir, 'apps', 'host')],
      'only the root-declaring app seeds an app dir; the command-only remote does not'
    );
    // reasons keep the old contract byte-for-byte (conflicts + the hint).
    assert.match(result.reasons.join('\n'), /port 8081 declared by host is already busy/);
    assert.match(result.reasons.join('\n'), /port 8082 declared by a is already busy/);
    assert.match(result.reasons.at(-1)!, /--auto-ports/);
  });

  it('a duplicate-declared conflict (nothing busy) carries NO busyPorts/appDirs keys', async () => {
    // Same port declared by both apps, nothing actually busy: allocatePorts
    // reports a conflict no orphan kill could ever fix, so the caller's gate
    // (`busyPorts !== undefined`) must stay closed.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-conflict-'));
    conflictDirs.push(dir);
    writeFileSync(
      path.join(dir, 'repack-federation.json'),
      JSON.stringify({
        host: { manifest: './h.json', port: 8082, command: 'true' },
        remotes: { a: { manifest: './a.json', port: 8082, command: 'true' } },
      })
    );
    const fs = createNodeProjectFs();
    const result = await resolveDevPlan({
      workspaceDir: dir,
      configReader: createWorkspaceConfigReader(fs),
      manifestSource: createManifestSource(fs),
      reactNativeCli: createReactNativeCliResolver(),
      fs,
      processRunner: {
        start: () => {
          throw new Error('never spawns');
        },
        isPortBusy: async () => false,
        findFreePort: async () => 50_000,
      },
      autoPorts: false,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal('busyPorts' in result, false);
    assert.equal('appDirs' in result, false);
  });
});

// ---------------------------------------------------------------------------
// F12: writeAppInput — typed input routed to a supervised app's stdin
// ---------------------------------------------------------------------------

function appPlan(key: string, name: string, command: string): DevAppPlan {
  return {
    key,
    name,
    role: key === 'host' ? 'host' : 'remote',
    launch: { kind: 'command', command },
    cwd: `/ws/apps/${key}`,
    port: key === 'host' ? 8081 : 8082,
    portSource: 'declared',
  };
}

function supervisorWithApps(
  apps: DevAppPlan[],
  processRunner: ProcessRunner
) {
  const plan: Extract<DevPlanResult, { ok: true }> = {
    ok: true,
    configDir: '/ws',
    entries: [],
    apps,
    skipped: [],
    warnings: [],
    reassignments: [],
  };
  return createDevSupervisor({
    plan,
    processRunner,
    onLog: () => {},
    onStatus: () => {},
    staggerMs: 0,
  });
}

describe('writeAppInput (F12)', () => {
  function runnerByCommand(
    children: Record<string, FakeChild>
  ): ProcessRunner {
    return {
      // Command apps spawn with `shell: true` and the command as `file`.
      start: (spec) => {
        const child = children[spec.file];
        if (child === undefined) throw new Error(`unexpected spawn ${spec.file}`);
        return child.handle;
      },
      isPortBusy: async () => false,
      findFreePort: async () => 50_000,
    };
  }

  it('routes by graph name AND by plan key, false when nothing writable or dead', async () => {
    const host = fakeChild({ writableStdin: true });
    const alpha = fakeChild({ writableStdin: true });
    const supervisor = supervisorWithApps(
      [appPlan('host', 'host_app', 'run-host'), appPlan('alpha', 'alpha', 'run-alpha')],
      runnerByCommand({ 'run-host': host, 'run-alpha': alpha })
    );
    await supervisor.start();

    assert.equal(supervisor.writeAppInput('host_app', 'r'), true);
    assert.equal(supervisor.writeAppInput('alpha', 'w'), true);
    // The port contract: the caller's line arrives with its newline.
    assert.deepEqual(host.written(), ['r\n']);
    assert.deepEqual(alpha.written(), ['w\n']);

    // Unknown app: false, nothing written anywhere.
    assert.equal(supervisor.writeAppInput('ghost', 'x'), false);
    assert.deepEqual(host.written(), ['r\n']);

    // Exited child: no live handle -> false.
    alpha.exit({ code: 0, signal: null });
    await tick();
    assert.equal(supervisor.writeAppInput('alpha', 'late'), false);
    assert.deepEqual(alpha.written(), ['w\n']);

    await supervisor.shutdown();
  });

  it('false when the handle does not implement writeStdin (optional port member)', async () => {
    const host = fakeChild(); // no writable stdin at all
    const supervisor = supervisorWithApps(
      [appPlan('host', 'host_app', 'run-host')],
      runnerByCommand({ 'run-host': host })
    );
    await supervisor.start();
    assert.equal(supervisor.writeAppInput('host', 'r'), false);
    await supervisor.shutdown();
  });

  it('false after shutdown (no live routing into a dying session)', async () => {
    const host = fakeChild({ writableStdin: true });
    const supervisor = supervisorWithApps(
      [appPlan('host', 'host_app', 'run-host')],
      runnerByCommand({ 'run-host': host })
    );
    await supervisor.start();
    assert.equal(supervisor.writeAppInput('host', 'r'), true);
    await supervisor.shutdown();
    assert.equal(supervisor.writeAppInput('host', 'r'), false);
  });

  it('one-shot children are NOT routable by name', async () => {
    const host = fakeChild({ writableStdin: true });
    const launchChild = fakeChild({ writableStdin: true });
    const supervisor = supervisorWithApps(
      [appPlan('host', 'host_app', 'run-host')],
      {
        start: (spec) =>
          (spec.file === 'run-host' ? host : launchChild).handle,
        isPortBusy: async () => false,
        findFreePort: async () => 50_000,
      }
    );
    await supervisor.start();
    supervisor.spawnOneShot('launch', SPEC);
    // 'launch' is not a managed app row, so writeAppInput must never reach
    // the transient one-shot handle (documented in the supervisor).
    assert.equal(supervisor.writeAppInput('launch', 'r'), false);
    assert.deepEqual(launchChild.written(), []);
    await supervisor.shutdown();
  });
});
