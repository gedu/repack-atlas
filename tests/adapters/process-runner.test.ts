// ProcessRunner adapter tests: real `node -e` children — streams, exit,
// process-group kill without orphans, and the two-leg port probe (busy vs
// free) against real loopback sockets. Ported semantics: busy-probe legs
// and timeouts come from `portPlanner.ts` (branch feat/federation-dev-runner).

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { createNodeProcessRunner } from '../../src/adapters/index.js';

const runner = createNodeProcessRunner();
const openHandles: { close(): void }[] = [];

after(async () => {
  for (const handle of openHandles) handle.close();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('start / env', () => {
  it('an env key set to undefined is removed from the child; others merge over process.env', async () => {
    process.env.ATLAS_TEST_STRAY = 'inherited';
    try {
      const handle = runner.start({
        file: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify([process.env.ATLAS_TEST_STRAY ?? null, process.env.ATLAS_TEST_SET ?? null]))',
        ],
        env: { ATLAS_TEST_STRAY: undefined, ATLAS_TEST_SET: 'yes' },
      });
      const out: string[] = [];
      handle.subscribeToStdout((line) => out.push(line));
      await handle.waitForExit();
      assert.deepEqual(JSON.parse(out[0]!), [null, 'yes']);
    } finally {
      delete process.env.ATLAS_TEST_STRAY;
    }
  });
});

describe('start / streams / exit', () => {
  it('captures stdout and stderr line-wise and reports the exit code', async () => {
    const handle = runner.start({
      file: process.execPath,
      args: [
        '-e',
        'console.log("out-1"); console.error("err-1"); console.log("out-2"); process.exit(3);',
      ],
    });
    const out: string[] = [];
    const err: string[] = [];
    handle.subscribeToStdout((line) => out.push(line));
    handle.subscribeToStderr((line) => err.push(line));
    const exit = await handle.waitForExit();
    // 'close' fires after stdio drains, so lines are complete here.
    assert.deepEqual(out, ['out-1', 'out-2']);
    assert.deepEqual(err, ['err-1']);
    assert.equal(exit.code, 3);
    assert.ok(typeof handle.pid === 'number');
  });

  it('waitForExit never rejects for a nonexistent executable', async () => {
    const handle = runner.start({ file: 'definitely-not-a-binary-42' });
    const exit = await handle.waitForExit();
    assert.equal(exit.code, null);
    assert.equal(exit.signal, 'spawn-error');
  });

  it('unsubscribe stops delivery', async () => {
    const handle = runner.start({
      file: process.execPath,
      args: ['-e', 'console.log("a"); console.log("b");'],
    });
    const lines: string[] = [];
    const unsubscribe = handle.subscribeToStdout((l) => lines.push(l));
    unsubscribe();
    await handle.waitForExit();
    assert.deepEqual(lines, []);
  });
});

describe('writeStdin (F12)', () => {
  it('bytes written reach the child stdin and flow back out', async () => {
    // `node -e` reading stdin is the smallest honest proof the pipe is
    // really wired: echo one line back and assert it came out of stdout.
    const handle = runner.start({
      file: process.execPath,
      args: [
        '-e',
        'process.stdin.setEncoding("utf-8");process.stdin.on("data",(d)=>process.stdout.write("echo:"+d));',
      ],
    });
    const lines: string[] = [];
    handle.subscribeToStdout((line) => lines.push(line));
    assert.equal(handle.writeStdin?.('hello\n'), true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(lines, ['echo:hello']);
    handle.signal('SIGKILL');
    await handle.waitForExit();
  });

  it('reports false once the child is gone, without crashing the host', async () => {
    // EPIPE on a dead child's stdin must surface as `false`, never as an
    // unhandled 'error' event on the stream.
    const rejections: unknown[] = [];
    const onError = (error: Error) => rejections.push(error);
    process.on('error', onError);
    try {
      const handle = runner.start({
        file: process.execPath,
        args: ['-e', 'process.exit(0)'],
      });
      await handle.waitForExit();
      const wrote = handle.writeStdin?.('late\n') ?? false;
      assert.equal(wrote, false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(rejections, []);
    } finally {
      process.off('error', onError);
    }
  });
});

describe('killTree', () => {
  it('kills the whole process group: no orphan grandchild survives', async () => {
    // The child spawns a grandchild that ignores SIGINT; both share the
    // child's process group, which killTree signals. Two CI-only races,
    // both fixed by construction:
    //  1. Signal handlers are installed BEFORE the pid is printed. stdout
    //     flushes as soon as console.log runs, so a group SIGINT could land
    //     while the child was still between statements — default handling
    //     killed it (exit code null, the CI failure).
    //  2. The child outlives the grandchild and REAPS it: an orphaned,
    //     unreaped zombie still answers `kill(pid, 0)`, so the liveness
    //     probe would see a dead grandchild as alive. The child exits only
    //     from the grandchild's 'exit' event, and ignores SIGINT/SIGTERM
    //     itself, so the deterministic path is: group SIGINT (ignored by
    //     both or kills a not-yet-exec'd grandchild) → group SIGTERM kills
    //     the grandchild → child reaps it and exits 0.
    const script = [
      'process.on("SIGINT", () => {});',
      'process.on("SIGTERM", () => {});',
      'const { spawn } = require("node:child_process");',
      'const grand = spawn(process.execPath, ["-e",',
      '  "process.on(\'SIGINT\', () => {}); setInterval(() => {}, 1000);",',
      '  { stdio: "ignore" }]);',
      'grand.once("exit", () => process.exit(0));',
      'console.log(String(grand.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const handle = runner.start({
      file: process.execPath,
      args: ['-e', script],
    });
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('grandchild pid never printed')),
        10_000
      );
      handle.subscribeToStdout((line) => {
        clearTimeout(timer);
        resolve(Number(line));
      });
    });

    assert.ok(handle.pid !== null && isAlive(handle.pid));
    assert.ok(isAlive(grandchildPid));

    await handle.killTree(1_500);

    const exit = await handle.waitForExit();
    assert.notDeepEqual(exit, { code: null, signal: null });
    // The child caught the group signals and exited only after reaping the
    // grandchild the group SIGTERM killed.
    assert.equal(exit.code, 0);
    assert.ok(!isAlive(handle.pid!), 'child survived killTree');
    assert.ok(!isAlive(grandchildPid), 'orphaned grandchild survived killTree');
  });

  it('is a no-op on an already-exited child', async () => {
    const handle = runner.start({
      file: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    await handle.waitForExit();
    await handle.killTree(200);
    assert.ok(true);
  });
});

describe('port probes', () => {
  it('reports a listening port busy and a free port free', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    openHandles.push(server);

    assert.equal(await runner.isPortBusy(port), true);

    const free = await runner.findFreePort();
    assert.ok(free > 0 && free < 65_536);
    assert.equal(await runner.isPortBusy(free), false);
  });

  it('findFreePort does not report a busy port', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const busyPort = (server.address() as AddressInfo).port;
    openHandles.push(server);
    // Allocate several; none may collide with the listener above.
    for (let i = 0; i < 3; i += 1) {
      assert.notEqual(await runner.findFreePort(), busyPort);
    }
  });
});
