// Supervisor unit tests over a fake ProcessRunner: the one-shot (launch)
// child must stay supervised whatever its reporting hook does.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ProcessHandle,
  ProcessRunner,
  SpawnSpec,
} from '../../src/core/index.js';
import {
  createDevSupervisor,
  type OneShotEvent,
  type OneShotSpec,
} from '../../src/runner/supervisor.js';

const SPEC: OneShotSpec = { file: 'rn', args: ['run-ios'], cwd: '/ws' };

interface FakeChild {
  handle: ProcessHandle;
  exit(result: { code: number | null; signal: string | null }): void;
  killed(): boolean;
}

function fakeChild(): FakeChild {
  let finish!: (r: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      finish = resolve;
    }
  );
  let killed = false;
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
    },
    exit: finish,
    killed: () => killed,
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
