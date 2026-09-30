// T9 runner integration tests: spawn the BUILT bin (`node dist/cli.js dev`)
// on the fixture workspace and drive it through its real surfaces — the
// `--json` event stream, the Studio HTTP routes it serves, real child
// processes on real ports, and real signals. Everything here is the demo
// stub bundler (fixtures/workspace/tools/stub-bundler.mjs), so each session
// costs seconds, per the fixture budget rule.
//
// Port policy: `--studio-port 0` (ephemeral, parsed from the studio event)
// and no `--port`-style overrides, so parallel CI jobs never collide. The
// stub apps keep their declared 8082/8083 ports: the plan probes them free
// before spawning, and a collision fails loudly, never silently.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { binPath, ensureBin, repoRoot } from '../cli/run-bin.js';

const WORKSPACE = path.join(repoRoot, 'fixtures', 'workspace');
const CYCLE_WORKSPACE = path.join(repoRoot, 'fixtures', 'fixture-remote-cycle');

interface DevEvent {
  event: string;
  url?: string;
  app?: string;
  status?: string;
  port?: number;
  pid?: number;
  code?: number;
}

interface Session {
  child: ChildProcess;
  events: DevEvent[];
  lines: string[];
  exited: Promise<{ code: number | null }>;
  /** Resolve once `count` app events for `app` reached `status`. */
  waitForStatus(
    app: string,
    status: string,
    timeoutMs?: number
  ): Promise<DevEvent>;
  waitForEvent(
    predicate: (event: DevEvent) => boolean,
    timeoutMs?: number
  ): Promise<DevEvent>;
}

async function startSession(args: string[], cwd = WORKSPACE): Promise<Session> {
  const child = spawn(process.execPath, [binPath, 'dev', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const session: Session = {
    child,
    events: [],
    lines: [],
    exited: new Promise((resolve) => {
      child.once('close', (code) => resolve({ code }));
    }),
    waitForStatus,
    waitForEvent,
  };
  let notify: (() => void) | null = null;
  const onData = (data: Buffer) => {
    for (const line of data.toString('utf8').split('\n')) {
      if (line === '') continue;
      session.lines.push(line);
      if (line.startsWith('{')) {
        session.events.push(JSON.parse(line) as DevEvent);
        notify?.();
      }
    }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData); // warnings/plan failures ride stderr

  async function waitFor(
    found: () => DevEvent | undefined,
    timeoutMs: number,
    what: string
  ): Promise<DevEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = found();
      if (hit) return hit;
      const woke = await Promise.race([
        session.exited, // exited before the event → fail with context
        new Promise<'wake'>((resolve) => {
          notify = () => resolve('wake');
          setTimeout(() => resolve('wake'), 100).unref();
        }),
      ]);
      if (woke !== 'wake') {
        assert.fail(
          `dev exited before ${what}; events so far: ${JSON.stringify(session.events)}\nlines: ${session.lines.join('\n')}`
        );
      }
      assert.ok(
        Date.now() < deadline,
        `timeout waiting for ${what}; events: ${JSON.stringify(session.events)}\nlines: ${session.lines.join('\n')}`
      );
    }
  }

  function waitForStatus(app: string, status: string, timeoutMs = 15_000) {
    return waitFor(
      () =>
        session.events.find(
          (e) => e.event === 'app' && e.app === app && e.status === status
        ),
      timeoutMs,
      `app ${app} status ${status}`
    );
  }

  function waitForEvent(predicate: (e: DevEvent) => boolean, timeoutMs = 15_000) {
    return waitFor(() => session.events.find(predicate), timeoutMs, 'event');
  }

  return session;
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(
              new Error(`${url} did not answer JSON: ${body.slice(0, 200)} (${String(error)})`)
            );
          }
        });
      })
      .on('error', reject);
  });
}

function requestRaw(
  url: string,
  method: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body })
      );
    });
    request.on('error', reject);
    request.end();
  });
}

/** Subscribe to the Studio SSE stream; collect `event: graph` frames. */
function subscribeSse(url: string): {
  frames: () => string[];
  close: () => void;
} {
  const frames: string[] = [];
  const eventsUrl = url.replace(/\/$/, '') + '/api/events';
  const request = http.get(eventsUrl, (response) => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      // Frames are `event: graph\ndata: {...}\n\n`.
      for (;;) {
        const at = buffer.indexOf('\n\n');
        if (at === -1) break;
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (frame.includes('event: graph')) frames.push(frame);
      }
    });
  });
  request.on('error', () => {});
  return {
    frames: () => [...frames],
    close: () => request.destroy(),
  };
}

const portIsBusy = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });

async function waitPortFree(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await portIsBusy(port)) {
    assert.ok(Date.now() < deadline, `port ${port} still busy`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(ensureBin);

// Close over every session so `after` can always reap children, even if a
// test fails midway (a leaked stub bundler holds 8082 for the next test).
const openSessions: Session[] = [];

async function session(args: string[], cwd = WORKSPACE): Promise<Session> {
  const s = await startSession(args, cwd);
  openSessions.push(s);
  return s;
}

after(async () => {
  for (const s of openSessions) {
    if (!s.child.killed) s.child.kill('SIGKILL');
  }
});

describe('dev runner (spawned, stub apps)', () => {
  it(
    'all three stub apps reach ready; /api/graph mirrors it; SSE pushes status changes',
    async () => {
      const s = await session(['--ci', '--json', '--studio-port', '0']);
      const studio = await s.waitForEvent((e) => e.event === 'studio');
      const url = studio.url!;
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

      const sse = subscribeSse(url);
      const ready = { host: false, mini_auth: false, mini_store: false };
      for (const app of Object.keys(ready) as (keyof typeof ready)[]) {
        await s.waitForStatus(app, 'ready');
        ready[app] = true;
      }

      const graph = await getJson<{
        apps: { name: string; status?: string; port?: number }[];
      }>(`${url.replace(/\/$/, '')}/api/graph`);
      for (const app of Object.keys(ready)) {
        const node = graph.apps.find((a) => a.name === app);
        assert.ok(node, `graph has ${app}`);
        assert.equal(node.status, 'ready', `${app} ready via /api/graph`);
      }

      // SSE: the initial subscribe frame arrived; killing an app must push
      // a newer graph frame reflecting a non-ready status for it.
      const baseline = sse.frames().length;
      assert.ok(baseline >= 1, 'SSE delivers the current graph on connect');
      const miniEvent = await s.waitForStatus('mini_auth', 'ready');
      // Kill the whole process GROUP (the child is a detached group leader;
      // the shell wrapper would otherwise orphan the stub node process).
      process.kill(-miniEvent.pid!, 'SIGKILL');
      await s.waitForStatus('mini_auth', 'error');
      const deadline = Date.now() + 5_000;
      while (sse.frames().length < baseline + 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        sse.frames().length >= baseline + 1,
        'SSE delivered a frame after the status change'
      );
      // The pushed graph reflects the death (raw-body contains the status).
      const latest = sse.frames()[sse.frames().length - 1]!;
      assert.match(latest, /"name":"mini_auth"[^\n]*?"status":"error"/);

      s.child.kill('SIGINT');
      const { code } = await s.exited;
      // mini_auth died unexpectedly → the session reports it (exit 1).
      assert.equal(code, 1);
      const exit = await s.waitForEvent((e) => e.event === 'exit');
      assert.equal(exit.code, 1);
      sse.close();
    }
  );

  it(
    'SIGINT shuts everything down in order: ports released, exit 0',
    async () => {
      const s = await session(['--ci', '--json', '--studio-port', '0']);
      await s.waitForStatus('host', 'ready');
      const mini = await s.waitForStatus('mini_auth', 'ready');
      const store = await s.waitForStatus('mini_store', 'ready');
      const studio = await s.waitForEvent((e) => e.event === 'studio');

      s.child.kill('SIGINT');
      const { code } = await s.exited;
      assert.equal(code, 0);
      const exit = await s.waitForEvent((e) => e.event === 'exit');
      assert.equal(exit.code, 0);

      // killTree evidence: every child's port answered, now none does.
      await waitPortFree(mini.port!);
      await waitPortFree(store.port!);
      await waitPortFree(studioPortOf(studio.url!));
      assert.ok(
        s.lines.some((l) => l.startsWith('[host] ready')),
        'prefixed child output surfaced'
      );
      // The runner reaped the whole group: the pids are gone.
      await waitGroupGone(mini.pid!);
      await waitGroupGone(store.pid!);
    }
  );

  it('--apps host,mini_auth starts only those two', async () => {
    const s = await session([
      '--ci',
      '--json',
      '--studio-port',
      '0',
      '--apps',
      'host,mini_auth',
    ]);
    await s.waitForStatus('host', 'ready');
    await s.waitForStatus('mini_auth', 'ready');
    assert.equal(
      s.events.some((e) => e.event === 'app' && e.app === 'mini_store'),
      false,
      'mini_store never emitted an event'
    );
    assert.equal(
      s.lines.some((l) => l.includes('mini_store')),
      false,
      'mini_store never logged'
    );
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('--no-studio emits no studio event and no [host] suppression', async () => {
    const s = await session(['--ci', '--json', '--no-studio']);
    await s.waitForStatus('mini_store', 'ready');
    assert.equal(
      s.events.some((e) => e.event === 'studio'),
      false,
      'no {event:studio} without the Studio'
    );
    assert.ok(
      s.events.some((e) => e.event === 'app'),
      'app events still flow without the Studio'
    );
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('the dev-run Studio keeps the read-only rules: 405 on writes, 404 off-route', async () => {
    const s = await session(['--ci', '--json', '--studio-port', '0']);
    const studio = await s.waitForEvent((e) => e.event === 'studio');
    const base = studio.url!.replace(/\/$/, '');
    const post = await requestRaw(`${base}/api/graph`, 'POST');
    assert.equal(post.status, 405);
    assert.match(post.body, /read-only/);
    const missing = await requestRaw(`${base}/nope`, 'GET');
    assert.equal(missing.status, 404);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('dev over fixture-remote-cycle serves the cyclic graph (commandless apps warn and skip)', async () => {
    const s = await session(
      ['--ci', '--json', '--studio-port', '0'],
      CYCLE_WORKSPACE
    );
    const studio = await s.waitForEvent((e) => e.event === 'studio');
    const graph = await getJson<{
      apps: unknown[];
      edges: { from: string; to: string; cyclic: boolean }[];
    }>(`${studio.url!.replace(/\/$/, '')}/api/graph`);
    assert.equal(graph.apps.length, 3, 'nothing spawns, the graph still answers');
    assert.ok(
      graph.edges.some((e) => e.cyclic),
      `cycle edges visible via the runner path: ${JSON.stringify(graph.edges)}`
    );
    assert.ok(
      s.lines.some((l) => l.includes('no "command" declared')),
      'commandless apps report a warning'
    );
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });
});

function studioPortOf(url: string): number {
  return Number(new URL(url).port);
}

function processAlive(pid: number): boolean {
  try {
    // The group, not just the leader: children run as detached groups.
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGroupGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    assert.ok(Date.now() < deadline, `process group ${pid} still alive`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
