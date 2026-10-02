// T1 owner-probe tests (ODD dev-port-conflict-warn-kill): the lsof/ps
// parsers, the two-leg probe over a FAKE ProcessRunner with canned output
// (no real sockets, no real lsof), and the terminate guard.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import {
  createNodePortOwnership,
  createPortOwnerProbe,
  parseLsofPid,
  parsePsOwner,
} from '../../src/adapters/port-owner.js';
import { createNodeProcessRunner } from '../../src/adapters/process-runner.js';
import type {
  ProcessHandle,
  ProcessRunner,
  SpawnSpec,
} from '../../src/core/index.js';

describe('parseLsofPid', () => {
  it('takes the pid of the first LISTEN line, skipping the header', () => {
    assert.equal(
      parseLsofPid(
        'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n' +
          'node    4242 user   18u  IPv6 0x1      0t0  TCP *:8081 (LISTEN)\n'
      ),
      4242
    );
  });
  it('prefers the first listener when several lines appear', () => {
    assert.equal(
      parseLsofPid('node 11 u IPv6 TCP *:8081 (LISTEN)\nnode 22 u IPv6 TCP *:8081 (LISTEN)\n'),
      11
    );
  });
  it('answers null for empty or header-only output', () => {
    assert.equal(parseLsofPid(''), null);
    assert.equal(parseLsofPid('COMMAND  PID USER\n'), null);
  });
});

describe('parsePsOwner', () => {
  it('reads ppid and the full command from the ps line', () => {
    assert.deepEqual(
      parsePsOwner(
        4242,
        '    1 node /ws/apps/host/node_modules/react-native/cli.js start --port 8081\n'
      ),
      {
        pid: 4242,
        ppid: 1,
        command:
          'node /ws/apps/host/node_modules/react-native/cli.js start --port 8081',
      }
    );
  });
  it('answers null on empty ps output (pid gone between the legs)', () => {
    assert.equal(parsePsOwner(4242, ''), null);
  });
});

/** Fake runner answering lsof/ps with canned stdout; records every spec. */
function fakeOwnerRunner(canned: {
  lsof?: { code: number; stdout: string };
  ps?: { code: number; stdout: string };
}): { runner: ProcessRunner; specs: SpawnSpec[] } {
  const specs: SpawnSpec[] = [];
  const handleFor = (stdout: string, code: number): ProcessHandle => ({
    pid: 1,
    subscribeToStdout: (listener) => {
      for (const line of stdout.split('\n')) {
        if (line !== '') listener(line);
      }
      return () => {};
    },
    subscribeToStderr: () => () => {},
    waitForExit: async () => ({ code, signal: null }),
    signal: () => {},
    killTree: async () => {},
  });
  return {
    specs,
    runner: {
      start(spec: SpawnSpec): ProcessHandle {
        specs.push(spec);
        const isLsof = spec.file === 'lsof';
        const answer = isLsof
          ? (canned.lsof ?? { code: 1, stdout: '' })
          : (canned.ps ?? { code: 1, stdout: '' });
        return handleFor(answer.stdout, answer.code);
      },
      isPortBusy: async () => true,
      findFreePort: async () => 50_000,
    },
  };
}

describe('createPortOwnerProbe (fake ProcessRunner, canned lsof/ps)', () => {
  it('resolves pid, ppid and command through the lsof then ps legs', async () => {
    const { runner, specs } = fakeOwnerRunner({
      lsof: {
        code: 0,
        stdout:
          'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n' +
          'node    4242 user 18u IPv6 0t0 TCP 127.0.0.1:8081 (LISTEN)\n',
      },
      ps: {
        code: 0,
        stdout:
          '    1 node /ws/apps/host/node_modules/react-native/cli.js start --port 8081\n',
      },
    });
    const owner = await createPortOwnerProbe(runner).portOwner(8081);
    assert.deepEqual(owner, {
      pid: 4242,
      ppid: 1,
      command:
        'node /ws/apps/host/node_modules/react-native/cli.js start --port 8081',
    });
    assert.deepEqual(
      specs.map((s) => [s.file, ...(s.args ?? [])]),
      [
        ['lsof', '-nP', '-iTCP:8081', '-sTCP:LISTEN'],
        ['ps', '-ww', '-p', '4242', '-o', 'ppid=', '-o', 'command='],
      ],
      'the exact lsof/ps argv the task names'
    );
  });

  it('degrades to null (owner unknown) when lsof finds no listener', async () => {
    const { runner, specs } = fakeOwnerRunner({ lsof: { code: 1, stdout: '' } });
    assert.equal(await createPortOwnerProbe(runner).portOwner(8081), null);
    assert.equal(specs.length, 1, 'the ps leg is skipped when lsof has no answer');
  });

  it('degrades to null when lsof succeeds but has no LISTEN row', async () => {
    const { runner } = fakeOwnerRunner({
      lsof: { code: 0, stdout: 'COMMAND  PID USER\n' },
    });
    assert.equal(await createPortOwnerProbe(runner).portOwner(8081), null);
  });

  it('degrades to null when the ps leg fails (pid vanished)', async () => {
    const { runner } = fakeOwnerRunner({
      lsof: { code: 0, stdout: 'node 4242 user 18u IPv6 TCP *:8081 (LISTEN)\n' },
      ps: { code: 1, stdout: '' },
    });
    assert.equal(await createPortOwnerProbe(runner).portOwner(8081), null);
  });

  it('degrades to null when the runner cannot spawn at all', async () => {
    const runner: ProcessRunner = {
      start: () => {
        throw new Error('spawn failed');
      },
      isPortBusy: async () => true,
      findFreePort: async () => 50_000,
    };
    assert.equal(await createPortOwnerProbe(runner).portOwner(8081), null);
  });

  it('terminate refuses pid <= 1 without signalling anything', () => {
    // Signalling 0 or -1 would hit OUR OWN process group: the wrapper guard
    // must reject it before process.kill is ever reached.
    const ownership = createNodePortOwnership(fakeOwnerRunner({}).runner);
    assert.equal(ownership.terminate(1), false);
    assert.equal(ownership.terminate(0), false);
    assert.equal(ownership.terminate(-1), false);
    assert.equal(ownership.terminate(1.5), false);
  });

  it('terminate reports false for a pid that does not exist (ESRCH)', () => {
    const ownership = createNodePortOwnership(fakeOwnerRunner({}).runner);
    // Node's pid_max bounds this; an unused high pid is ESRCH on any unix.
    assert.equal(ownership.terminate(4_199_999), false);
  });
});

describe('createNodePortOwnership against a real listener (POSIX only)', () => {
  const sockets: net.Server[] = [];
  after(() => {
    for (const server of sockets) server.close();
  });

  it('names the real owner of a port this test process listens on', async () => {
    // The one real-spawn case: it proves the parsers against the actual
    // lsof/ps output shape (canned fakes can drift from it). Skipped where
    // the OS cannot answer (Windows) or where the tools are absent.
    if (process.platform === 'win32') return;
    const server = net.createServer();
    sockets.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const owner = await createNodePortOwnership(
      createNodeProcessRunner()
    ).portOwner(port);
    // A sandbox stripping lsof must degrade, not fail the check.
    if (owner === null) return;
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.ppid, process.ppid);
    assert.match(owner.command, /node/);
  });
});
