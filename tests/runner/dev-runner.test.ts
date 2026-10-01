// T9 runner integration tests: spawn the BUILT bin (`node dist/cli.js dev`)
// on the fixture workspace and drive it through its real surfaces — the
// `--json` event stream, the Studio HTTP routes it serves, real child
// processes on real ports, and real signals. Everything here is the demo
// stub bundler (fixtures/workspace/tools/stub-bundler.mjs), so each session
// costs seconds, per the fixture budget rule.
//
// Port policy: `--studio-port 0` (ephemeral, parsed from the studio event);
// the fixture host is pinned to a known-free port with `--port` (its default
// would be 8081). The stub remotes keep their declared 8082/8083 ports: the plan probes them free
// before spawning, and a collision fails loudly, never silently.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { binPath, ensureBin, repoRoot } from '../cli/run-bin.js';

const WORKSPACE = path.join(repoRoot, 'fixtures', 'workspace');
// The fixture's host declares no port, so the runner default would be 8081
// (often held by a real Metro). Tests on it pin the host with `--port`, a
// free port allocated once per run in `before` (never a fixed number).
let WORKSPACE_HOST_PORT = 0;
const CYCLE_WORKSPACE = path.join(repoRoot, 'fixtures', 'fixture-remote-cycle');

/**
 * A throwaway config over the cycle fixture's manifests (absolute refs) with
 * every `root` dropped: the fixture's apps declare a root, which would run
 * the default argv, and these tests are about apps with neither.
 */
function rootlessCycleWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-cycle-'));
  cleanupDirs.push(dir);
  const config = JSON.parse(
    readFileSync(path.join(CYCLE_WORKSPACE, 'repack-federation.json'), 'utf8')
  ) as {
    host: Record<string, unknown>;
    remotes: Record<string, Record<string, unknown>>;
  };
  for (const entry of [config.host, ...Object.values(config.remotes)]) {
    delete entry.root;
    entry.manifest = path.resolve(CYCLE_WORKSPACE, entry.manifest as string);
  }
  writeFileSync(
    path.join(dir, 'repack-federation.json'),
    JSON.stringify(config)
  );
  return dir;
}
const cleanupDirs: string[] = [];

interface DevEvent {
  event: string;
  apps?: { app: string; role: string; port: number | null; command: string; cwd: string; bundler?: string }[];
  url?: string;
  app?: string;
  status?: string;
  port?: number;
  pid?: number;
  code?: number | null;
  launch?: { app: string; command: string; cwd: string };
}

/** Additive plan-app fields T4 asserts on (the base interface stays loose). */
interface PlanApp {
  app: string;
  port: number | null;
  command: string;
  platform?: string;
  standalone?: boolean;
  reassignedFrom?: number;
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

/** Pin the fixture host to a known-free port unless the test chose one. */
function pinHostPort(args: string[], cwd: string): string[] {
  return cwd === WORKSPACE && !args.includes('--port')
    ? ['--port', String(WORKSPACE_HOST_PORT), ...args]
    : args;
}

async function startSession(
  args: string[],
  cwd = WORKSPACE,
  env?: NodeJS.ProcessEnv
): Promise<Session> {
  const child = spawn(process.execPath, [binPath, 'dev', ...pinHostPort(args, cwd)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
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

interface GraphFrame {
  apps?: { name: string; status?: string }[];
}

function parseFrame(frame: string): GraphFrame | null {
  const data = frame.split('\n').find((line) => line.startsWith('data: '));
  if (data === undefined) return null;
  try {
    return JSON.parse(data.slice('data: '.length)) as GraphFrame;
  } catch {
    return null;
  }
}

/** Poll the SSE frames until `app` reports `status`; fail listing what was seen. */
async function waitForFrameStatus(
  sse: { frames: () => string[] },
  app: string,
  status: string,
  timeoutMs = 10_000
): Promise<GraphFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = sse.frames().map(parseFrame);
    const hit = frames.find((f) => f?.apps?.some((a) => a.name === app && a.status === status));
    if (hit) return hit;
    if (Date.now() >= deadline) {
      const seen = frames.map((f, i) => {
        const current = f?.apps?.find((a) => a.name === app)?.status;
        return `#${i}: ${app}=${current ?? 'n/a'}`;
      });
      assert.fail(
        `no SSE graph frame had ${app} at status ${status} within ${timeoutMs}ms; frames seen: [${seen.join(', ')}]`
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
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

before(async () => {
  ensureBin();
  WORKSPACE_HOST_PORT = await freePort();
});

// The stub apps keep the ports the fixture declares (remotes 8082/8083, host via --port), so every test
// must start from released ports even if the previous one failed midway.
const stubPorts = (): number[] => [8082, 8083, WORKSPACE_HOST_PORT];

// Close over every session so `afterEach` can always reap children, even if a
// test fails midway (a leaked stub bundler holds 8082 for the next test).
let openSessions: Session[] = [];

async function session(
  args: string[],
  cwd = WORKSPACE,
  env?: NodeJS.ProcessEnv
): Promise<Session> {
  const s = await startSession(args, cwd, env);
  openSessions.push(s);
  return s;
}

/**
 * SIGKILL an app process group (children are detached group leaders). An
 * already-gone group (ESRCH) is fine; any other error is returned so the
 * caller can finish cleanup before surfacing it. Reused-pid protection is the
 * last-status filter in `reap`, not this function.
 */
function killGroup(pid: number): Error | undefined {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return error as Error;
  }
  return undefined;
}

/** Kill the runner and the app groups still running, then await the exit. */
async function reap(s: Session): Promise<void> {
  // Last event per app: groups that already reported `error` (killed on
  // purpose) or `stopped` are skipped so a reused pid is never signalled.
  const last = new Map<string, DevEvent>();
  for (const event of s.events) {
    if (event.event === 'app' && event.app !== undefined) last.set(event.app, event);
  }
  const pids = new Set<number>();
  for (const event of last.values()) {
    if (event.pid === undefined) continue;
    if (event.status === 'error' || event.status === 'stopped') continue;
    pids.add(event.pid);
  }
  // Every group and the runner are always signalled; errors surface after.
  const errors = [...pids]
    .map(killGroup)
    .filter((e): e is Error => e !== undefined);
  if (s.child.exitCode === null && s.child.signalCode === null) {
    s.child.kill('SIGKILL');
  }
  await s.exited;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} app groups could not be killed`);
  }
}

beforeEach(async () => {
  for (const port of stubPorts()) await waitPortFree(port);
});

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  const sessions = openSessions;
  openSessions = [];
  await Promise.all(sessions.map(reap));
  for (const port of stubPorts()) await waitPortFree(port);
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
      // The first frame after the kill may still show `starting`/`ready`:
      // read frames until the error transition arrives, never assert on one.
      const latest = await waitForFrameStatus(sse, 'mini_auth', 'error');
      assert.equal(latest.apps?.find((a) => a.name === 'mini_auth')?.status, 'error');

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

  it('dev over fixture-remote-cycle serves the cyclic graph (apps with no command or root warn and skip)', async () => {
    const s = await session(
      ['--ci', '--json', '--studio-port', '0'],
      rootlessCycleWorkspace()
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
      s.lines.some((l) =>
        l.includes('no "command" or "root" in repack-federation.json')
      ),
      'apps without command or root report a warning'
    );
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });
});

/** A port nothing listens on right now (bind to 0, read it, release it). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Listen on `count` ephemeral loopback ports; `close()` releases them. */
async function occupyPorts(
  count: number
): Promise<{ ports: number[]; close(): Promise<void> }> {
  const servers = Array.from({ length: count }, () => net.createServer());
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    )
  );
  return {
    ports: servers.map((s) => (s.address() as net.AddressInfo).port),
    close: () =>
      Promise.all(
        servers.map((s) => new Promise<void>((r) => s.close(() => r())))
      ).then(() => undefined),
  };
}

function parseEvents(stdout: string): DevEvent[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as DevEvent);
}

/** Temp workspace with a stub-free config; `command` apps just exit. */
function withConfig<T>(
  config: object,
  run: (dir: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-ports-'));
  writeFileSync(
    path.join(dir, 'repack-federation.json'),
    JSON.stringify(config)
  );
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Run `dev <args>` to completion; returns raw stdout/stderr and exit code. */
function runToCompletion(
  args: string[],
  cwd = WORKSPACE
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, 'dev', ...pinHostPort(args, cwd)], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A hang must fail fast, not stall the whole suite.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`dev ${args.join(' ')} did not exit in 30s`));
    }, 30_000);
  });
}

describe('dev --dry-run', () => {
  it('prints the plan table, exits 0 and spawns nothing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-dry-'));
    try {
      writeFileSync(
        path.join(dir, 'repack-federation.json'),
        JSON.stringify({
          host: {
            manifest: './host.json',
            port: await freePort(),
            command: `node -e "require('fs').writeFileSync('marker','x')"`,
          },
          remotes: { idle: { manifest: './idle.json', command: 'true' } },
        })
      );
      const result = await runToCompletion(['--dry-run'], dir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^app\s+role\s+port\s+command\s+cwd$/m);
      assert.match(result.stdout, /^host\s+host\s+\d+\s+node -e/m);
      assert.match(result.stdout, /^idle\s+remote\s+auto\s+true/m);
      assert.ok(!result.stdout.includes('Federation Studio'), 'no Studio');
      assert.ok(!existsSync(path.join(dir, 'marker')), 'command never ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--dry-run --json emits exactly plan then exit, byte-identical across runs', async () => {
    const first = await runToCompletion(['--dry-run', '--json']);
    const second = await runToCompletion(['--dry-run', '--json']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    const events = first.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as DevEvent);
    assert.deepEqual(
      events.map((e) => e.event),
      ['plan', 'exit']
    );
    assert.deepEqual(
      events[0]!.apps!.map((a) => [a.app, a.role, a.port]),
      [
        ['host', 'host', WORKSPACE_HOST_PORT],
        ['mini_auth', 'remote', 8082],
        ['mini_store', 'remote', 8083],
      ]
    );
    assert.equal(events[1]!.code, 0);
  });

  it('a busy declared port is reported and exits 1 without spawning', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve)
    );
    const busy = (blocker.address() as net.AddressInfo).port;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-dry-'));
    try {
      writeFileSync(
        path.join(dir, 'repack-federation.json'),
        JSON.stringify({
          host: { manifest: './host.json', port: busy, command: 'true' },
          remotes: {},
        })
      );
      const result = await runToCompletion(['--dry-run', '--json'], dir);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`port ${busy} declared by host`));
      const exit = result.stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as DevEvent)
        .at(-1);
      assert.equal(exit?.code, 1);
    } finally {
      blocker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plan failures exit 2 under --dry-run: missing config, invalid config, unknown --apps', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'atlas-dry-'));
    try {
      const missing = await runToCompletion(['--dry-run'], empty);
      assert.equal(missing.code, 2);
      assert.match(missing.stderr, /no repack-federation\.json found/);

      writeFileSync(path.join(empty, 'repack-federation.json'), '{ not json');
      const invalid = await runToCompletion(['--dry-run', '--json'], empty);
      assert.equal(invalid.code, 2);
      assert.match(invalid.stderr, /repack-federation\.json/);
      assert.equal(invalid.stdout, '', 'no plan or exit event on a failed plan');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    const unknown = await runToCompletion(['--dry-run', '--apps', 'nope']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown apps: nope/);
  });

  it('apps without command or root surface their skip reason in dry-run', async () => {
    const result = await runToCompletion(['--dry-run'], rootlessCycleWorkspace());
    assert.match(
      result.stderr,
      /warning\s+\S+: no "command" or "root" in repack-federation\.json/
    );
  });

  it('a live session emits the additive plan event before spawning', async () => {
    const s = await session(['--ci', '--json', '--studio-port', '0']);
    const plan = await s.waitForEvent((e) => e.event === 'plan');
    await s.waitForStatus('host', 'starting');
    assert.deepEqual(
      plan.apps!.map((a) => a.app),
      ['host', 'mini_auth', 'mini_store']
    );
    assert.ok(
      s.events.findIndex((e) => e.event === 'plan') <
        s.events.findIndex((e) => e.event === 'app'),
      'plan precedes the first app event'
    );
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });
});

describe('dev ports (--port, --auto-ports, unified conflicts)', () => {
  const LISTEN = `node -e "require('net').createServer().listen(process.env.ATLAS_APP_PORT,'127.0.0.1')"`;

  for (const bad of ['0', '65536', 'abc', '8081x', '-1', '1.5', '0x50', '1e3', ' 80', '+80']) {
    it(`--port ${bad} is rejected with exit 2`, async () => {
      const result = await runToCompletion(['--dry-run', '--port', bad]);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /--port must be a TCP port number \(1-65535\)/);
    });
  }

  it('--port overrides the host port only (dry-run --json)', async () => {
    const port = await freePort();
    const result = await runToCompletion([
      '--dry-run',
      '--json',
      '--port',
      String(port),
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      parseEvents(result.stdout)[0]!.apps!.map((a) => [a.app, a.port]),
      [
        ['host', port],
        ['mini_auth', 8082],
        ['mini_store', 8083],
      ]
    );
  });

  it('host port falls back to 8081 when neither --port nor config sets it', async () => {
    await withConfig(
      { host: { manifest: './h.json', command: 'true' }, remotes: {} },
      async (dir) => {
        const result = await runToCompletion(['--dry-run', '--json'], dir);
        const apps = parseEvents(result.stdout)[0]!.apps!;
        assert.equal(apps[0]!.port, 8081);
        // 8081 may be busy on the dev machine: only the plan is asserted.
        assert.ok(result.code === 0 || result.code === 1, result.stderr);
      }
    );
  });

  it('--port sets the host port in a live session (plan and app events agree)', async () => {
    const port = await freePort();
    const s = await session([
      '--ci',
      '--json',
      '--studio-port',
      '0',
      '--port',
      String(port),
    ]);
    const plan = await s.waitForEvent((e) => e.event === 'plan');
    assert.equal(plan.apps![0]!.port, port);
    const ready = await s.waitForStatus('host', 'ready');
    assert.equal(ready.port, port);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('dry-run reports ALL busy ports together and exits 1', async () => {
    const held = await occupyPorts(2);
    try {
      await withConfig(
        {
          host: { manifest: './h.json', port: held.ports[0], command: 'true' },
          remotes: {
            a: { manifest: './a.json', port: held.ports[1], command: 'true' },
            b: { manifest: './b.json', command: 'true' },
          },
        },
        async (dir) => {
          const result = await runToCompletion(['--dry-run', '--json'], dir);
          assert.equal(result.code, 1);
          assert.match(result.stderr, new RegExp(`port ${held.ports[0]} declared by host`));
          assert.match(result.stderr, new RegExp(`port ${held.ports[1]} declared by a`));
          assert.match(result.stderr, /--auto-ports/);
          assert.equal(parseEvents(result.stdout).at(-1)?.code, 1);
        }
      );
    } finally {
      await held.close();
    }
  });

  it('dry-run --auto-ports reassigns busy ports; unmanaged remotes stay auto', async () => {
    const held = await occupyPorts(1);
    try {
      await withConfig(
        {
          host: { manifest: './h.json', port: held.ports[0], command: 'true' },
          remotes: { b: { manifest: './b.json', command: 'true' } },
        },
        async (dir) => {
          const result = await runToCompletion(['--dry-run', '--auto-ports'], dir);
          assert.equal(result.code, 0, result.stderr);
          assert.match(result.stderr, new RegExp(`port ${held.ports[0]} for host was busy`));
          assert.match(result.stdout, /^b\s+remote\s+auto\s+true/m);
          const hostRow = /^host\s+host\s+(\d+)/m.exec(result.stdout);
          assert.ok(hostRow && Number(hostRow[1]) !== held.ports[0]);

          const json = await runToCompletion(['--dry-run', '--json', '--auto-ports'], dir);
          const apps = parseEvents(json.stdout)[0]!.apps!;
          assert.notEqual(apps[0]!.port, held.ports[0]);
          assert.equal(apps[1]!.port, null);
          assert.equal(json.stderr.includes('was busy'), false, 'json stays quiet');
        }
      );
    } finally {
      await held.close();
    }
  });

  it('live: ALL busy ports are reported together, exit 1, nothing spawned', async () => {
    const held = await occupyPorts(2);
    try {
      await withConfig(
        {
          host: {
            manifest: './h.json',
            port: held.ports[0],
            command: `node -e "require('fs').writeFileSync('marker','x')"`,
          },
          remotes: {
            a: { manifest: './a.json', port: held.ports[1], command: 'true' },
          },
        },
        async (dir) => {
          const result = await runToCompletion(['--ci', '--json', '--studio-port', '0'], dir);
          assert.equal(result.code, 1, result.stderr);
          assert.match(result.stderr, new RegExp(`port ${held.ports[0]} declared by host`));
          assert.match(result.stderr, new RegExp(`port ${held.ports[1]} declared by a`));
          assert.ok(!existsSync(path.join(dir, 'marker')), 'nothing spawned');
          assert.equal(parseEvents(result.stdout).length, 0, 'no events before the plan');
        }
      );
    } finally {
      await held.close();
    }
  });

  it('live --auto-ports starts the app on a free port and reports it in plan and app events', async () => {
    const held = await occupyPorts(1);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'atlas-ports-'));
    try {
      writeFileSync(
        path.join(dir, 'repack-federation.json'),
        JSON.stringify({
          host: { manifest: './h.json', port: held.ports[0], command: LISTEN },
          remotes: {},
        })
      );
      const s = await session(
        ['--ci', '--json', '--studio-port', '0', '--auto-ports'],
        dir
      );
      const plan = await s.waitForEvent((e) => e.event === 'plan');
      const ready = await s.waitForStatus('host', 'ready');
      assert.notEqual(plan.apps![0]!.port, held.ports[0]);
      assert.equal(ready.port, plan.apps![0]!.port);
      assert.equal(
        s.lines.some((l) => l.includes('was busy')),
        false,
        '--json keeps the reassignment note out of the stream'
      );
      s.child.kill('SIGINT');
      assert.equal((await s.exited).code, 0);
    } finally {
      await held.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

// --- default argv (ODD dev-wizard-runner T3) ---------------------------------

/** Stub `react-native` CLI: records its argv/cwd and listens on `--port`. */
const STUB_RN_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] && args[0].startsWith('run-')) {
  // The launch one-shot (T5): record argv in the app root, then behave as
  // the \`launch-mode\` file says: 'fail' exits 1, 'hang' lingers until killed.
  const fs = require('fs');
  fs.appendFileSync('launch.log', JSON.stringify(args) + '\\n');
  fs.appendFileSync('launch.env', String(process.env.ATLAS_SHIM_RAN) + '\\n');
  console.log('launch-stub ' + JSON.stringify(args));
  const mode = fs.existsSync('launch-mode') ? fs.readFileSync('launch-mode', 'utf8').trim() : '';
  if (mode === 'fail') {
    console.error('launch-stub failing');
    process.exit(1);
  }
  if (mode === 'hang') {
    fs.writeFileSync('launch.pid', String(process.pid));
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
    setTimeout(() => process.exit(0), 30000);
  } else {
    process.exit(0);
  }
} else {
// Like the real CLI, reject options the app's react-native.config start
// command does not declare (published Re.Pack 5.x has no --bundler).
const declared = new Set();
for (const command of require(process.cwd() + '/react-native.config.js').commands) {
  if (command.name === 'start') {
    for (const option of command.options) declared.add(option.name.split(' ')[0]);
  }
}
for (const arg of args.slice(1)) {
  if (arg.startsWith('--') && !declared.has(arg)) {
    console.error("error: unknown option '" + arg + "'");
    process.exit(1);
  }
}
const port = Number(args[args.indexOf('--port') + 1]);
console.log('rn-stub ' + JSON.stringify({ args, cwd: process.cwd(), shim: process.env.ATLAS_SHIM_RAN || null }));
require('net').createServer().listen(port, '127.0.0.1');
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
}
`;

/** `start` options of the installed Re.Pack, as the app's RN config declares. */
const REPACK5_START_OPTIONS = [
  '--port <number>',
  '--no-interactive',
  '--platform <string>',
  '--config <path>',
  '--no-reverse-port',
];
/** Re.Pack from callstack/repack PR #1467: adds --bundler and --standalone. */
const PR1467_START_OPTIONS = [
  ...REPACK5_START_OPTIONS,
  '--bundler <type>',
  '--standalone',
];

/**
 * Install the stub react-native (package + cli), a bundler config and a
 * react-native.config.js whose `start` command declares the options of the
 * chosen Re.Pack shape (default: the #1467 build the argv rules were
 * written against).
 */
function makeApp(
  workspace: string,
  dir: string,
  options: {
    rn?: boolean;
    configFiles?: string[];
    repack?: 'repack5' | 'pr1467';
    /** Also install `node_modules/.bin/react-native` (like pnpm/npm do). */
    shim?: boolean;
  } = {}
): string {
  const root = path.join(workspace, dir);
  mkdirSync(root, { recursive: true });
  for (const file of options.configFiles ?? ['rspack.config.js']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  }
  if (options.rn !== false) {
    const declared =
      options.repack === 'repack5' ? REPACK5_START_OPTIONS : PR1467_START_OPTIONS;
    writeFileSync(
      path.join(root, 'react-native.config.js'),
      `module.exports = { commands: [{ name: 'start', options: ${JSON.stringify(
        declared.map((name) => ({ name }))
      )} }] };\n`
    );
    const pkg = path.join(root, 'node_modules', 'react-native');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'react-native', bin: { 'react-native': './cli.js' } })
    );
    writeFileSync(path.join(pkg, 'cli.js'), STUB_RN_CLI);
    if (options.shim === true) {
      // Like pnpm's shim: sets up the environment, then runs the real script.
      const bin = path.join(root, 'node_modules', '.bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        path.join(bin, 'react-native'),
        `#!/bin/sh\nexport ATLAS_SHIM_RAN=1\nexec "${process.execPath}" "${path.join(pkg, 'cli.js')}" "$@"\n# cmd-shim-target=${path.join(pkg, 'cli.js')}\n`
      );
      chmodSync(path.join(bin, 'react-native'), 0o755);
    }
  }
  return root;
}

describe('dev default argv (root without command)', () => {
  const listenScript =
    "require('net').createServer().listen(Number(process.env.ATLAS_APP_PORT), '127.0.0.1');\n";

  function workspaceWith(
    config: object,
    build: (dir: string) => void
  ): string {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-argv-')));
    cleanupDirs.push(dir);
    build(dir);
    writeFileSync(
      path.join(dir, 'repack-federation.json'),
      JSON.stringify(config)
    );
    return dir;
  }

  it('Re.Pack 5.x shape: no --bundler is passed (the stub would reject it) and the app still starts', async () => {
    const port = await freePort();
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => makeApp(d, 'apps/host', { repack: 'repack5' })
    );
    const s = await session(
      ['--ci', '--json', '--no-studio', '--port', String(port)],
      dir
    );
    await s.waitForStatus('host', 'ready');
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.equal(
      plan.apps![0]!.command,
      `node node_modules/react-native/cli.js start --port ${port} --no-interactive`
    );
    assert.equal(plan.apps![0]!.bundler, 'rspack', 'the detected bundler is still shown');
    const line = s.lines.find((l) => l.startsWith('[host] rn-stub '))!;
    const seen = JSON.parse(line.slice('[host] rn-stub '.length)) as { args: string[] };
    assert.deepEqual(seen.args, ['start', '--port', String(port), '--no-interactive']);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('prefers the app\'s .bin/react-native shim (its environment reaches the CLI)', async () => {
    const port = await freePort();
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => makeApp(d, 'apps/host', { repack: 'repack5', shim: true })
    );
    const s = await session(['--ci', '--json', '--no-studio', '--port', String(port)], dir);
    await s.waitForStatus('host', 'ready');
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.equal(
      plan.apps![0]!.command,
      `node_modules/.bin/react-native start --port ${port} --no-interactive`
    );
    const line = s.lines.find((l) => l.startsWith('[host] rn-stub '))!;
    const seen = JSON.parse(line.slice('[host] rn-stub '.length)) as { args: string[]; shim: string | null };
    assert.deepEqual(seen.args, ['start', '--port', String(port), '--no-interactive']);
    assert.equal(seen.shim, '1', 'the shim ran and exported its environment');
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('without a shim (npm/yarn layouts) it falls back to `node <cli.js>`', async () => {
    const port = await freePort();
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => makeApp(d, 'apps/host', { repack: 'repack5' })
    );
    const s = await session(['--ci', '--json', '--no-studio', '--port', String(port)], dir);
    await s.waitForStatus('host', 'ready');
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.match(plan.apps![0]!.command, /^node node_modules\/react-native\/cli\.js start /);
    const line = s.lines.find((l) => l.startsWith('[host] rn-stub '))!;
    assert.equal((JSON.parse(line.slice('[host] rn-stub '.length)) as { shim: unknown }).shim, null);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('an app without a react-native config (options unknown) omits --bundler too', async () => {
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => {
        const root = makeApp(d, 'apps/host');
        rmSync(path.join(root, 'react-native.config.js'));
      }
    );
    const result = await runToCompletion(['--dry-run', '--json', '--port', String(await freePort())], dir);
    assert.equal(result.code, 0, result.stderr);
    const plan = parseEvents(result.stdout)[0]!;
    assert.doesNotMatch(plan.apps![0]!.command, /--bundler/);
    assert.match(plan.apps![0]!.command, /--no-interactive/);
  });

  it('an app with only `root` starts through the built argv and reaches ready', async () => {
    const port = await freePort();
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => makeApp(d, 'apps/host')
    );
    const s = await session(
      ['--ci', '--json', '--no-studio', '--port', String(port)],
      dir
    );
    const ready = await s.waitForStatus('host', 'ready');
    assert.equal(ready.port, port);
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.equal(
      plan.apps![0]!.command,
      `node node_modules/react-native/cli.js start --bundler rspack --port ${port} --no-interactive`
    );
    assert.equal(plan.apps![0]!.cwd, path.join(dir, 'apps', 'host'));
    const line = s.lines.find((l) => l.startsWith('[host] rn-stub '))!;
    const seen = JSON.parse(line.slice('[host] rn-stub '.length)) as {
      args: string[];
      cwd: string;
    };
    assert.deepEqual(seen.args, [
      'start',
      '--bundler',
      'rspack',
      '--port',
      String(port),
      '--no-interactive',
    ]);
    assert.equal(realpathSync(seen.cwd), path.join(dir, 'apps', 'host'));
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('a `command` still overrides the argv (verbatim, config-dir cwd, no RN CLI needed)', async () => {
    const hostPort = await freePort();
    const dir = workspaceWith(
      {
        host: { manifest: './h.json', root: './apps/host' },
        remotes: {
          legacy: {
            manifest: './l.json',
            // Has a root but NO react-native install: the override must win.
            root: './apps/legacy',
            command: 'node listen.cjs',
          },
        },
      },
      (d) => {
        makeApp(d, 'apps/host');
        makeApp(d, 'apps/legacy', { rn: false, configFiles: [] });
        writeFileSync(path.join(d, 'listen.cjs'), listenScript);
      }
    );
    const s = await session(
      ['--ci', '--json', '--no-studio', '--port', String(hostPort)],
      dir
    );
    await s.waitForStatus('host', 'ready');
    await s.waitForStatus('legacy', 'ready');
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.equal(plan.apps![1]!.command, 'node listen.cjs');
    assert.equal(plan.apps![1]!.cwd, dir);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('`config` (relative to the config dir) picks the bundler and is passed as an absolute --config', async () => {
    const dir = workspaceWith(
      {
        host: {
          manifest: './h.json',
          root: './apps/host',
          config: 'apps/host/configs/webpack.dev.js',
        },
        remotes: {},
      },
      (d) => makeApp(d, 'apps/host', { configFiles: ['configs/webpack.dev.js'] })
    );
    const port = await freePort();
    const result = await runToCompletion(
      ['--dry-run', '--json', '--port', String(port)],
      dir
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      parseEvents(result.stdout)[0]!.apps![0]!.command,
      `node node_modules/react-native/cli.js start --bundler webpack --config ${path.join(dir, 'apps', 'host', 'configs', 'webpack.dev.js')} --port ${port} --no-interactive`
    );
  });

  it('detects webpack from .webpack/webpack.config.js', async () => {
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => makeApp(d, 'apps/host', { configFiles: ['.webpack/webpack.config.js'] })
    );
    const port = await freePort();
    const result = await runToCompletion(['--dry-run', '--json', '--port', String(port)], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(parseEvents(result.stdout)[0]!.apps![0]!.command, /--bundler webpack /);
  });

  it('dry-run --json with a built argv is byte-identical across runs', async () => {
    const dir = workspaceWith(
      {
        host: { manifest: './h.json', root: './apps/host', port: await freePort() },
        remotes: { r: { manifest: './r.json', root: './apps/r' } },
      },
      (d) => {
        makeApp(d, 'apps/host');
        makeApp(d, 'apps/r');
      }
    );
    const first = await runToCompletion(['--dry-run', '--json'], dir);
    const second = await runToCompletion(['--dry-run', '--json'], dir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.match(first.stdout, /--port <auto>/);
  });

  it('a missing react-native CLI exits 2 naming the app (live and dry-run)', async () => {
    const dir = workspaceWith(
      {
        host: { manifest: './h.json', command: 'true' },
        remotes: { zeta: { manifest: './z.json', root: './apps/zeta' } },
      },
      (d) => makeApp(d, 'apps/zeta', { rn: false })
    );
    for (const args of [['--dry-run'], ['--ci', '--json', '--no-studio']]) {
      const result = await runToCompletion([...args, '--port', String(await freePort())], dir);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /dev: zeta: cannot resolve the "react-native" package/);
      assert.ok(result.stderr.includes(path.join(dir, 'apps', 'zeta')), result.stderr);
      assert.doesNotMatch(result.stdout, /"event":"app"/, 'nothing spawned');
    }
  });

  it('no cross-app fallback: an app without its own CLI fails even if a sibling has one', async () => {
    const dir = workspaceWith(
      {
        host: { manifest: './h.json', root: './apps/host' },
        remotes: { other: { manifest: './o.json', root: './apps/other' } },
      },
      (d) => {
        makeApp(d, 'apps/host');
        makeApp(d, 'apps/other', { rn: false });
      }
    );
    const result = await runToCompletion(['--dry-run', '--port', String(await freePort())], dir);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /dev: other: cannot resolve/);
    assert.doesNotMatch(result.stderr, /dev: host:/);
  });

  it('--apps skips the toolchain of unselected apps', async () => {
    const dir = workspaceWith(
      {
        host: { manifest: './h.json', root: './apps/host' },
        remotes: { other: { manifest: './o.json', root: './apps/other' } },
      },
      (d) => {
        makeApp(d, 'apps/host');
        makeApp(d, 'apps/other', { rn: false });
      }
    );
    const port = await freePort();
    const result = await runToCompletion(
      ['--dry-run', '--apps', 'host', '--port', String(port)],
      dir
    );
    assert.equal(result.code, 0, result.stderr);
  });

  it('no config file, or both kinds, fall back to rspack (upstream default)', async () => {
    for (const configFiles of [[], ['rspack.config.js', 'webpack.config.js']]) {
      const dir = workspaceWith(
        { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
        (d) => makeApp(d, 'apps/host', { configFiles })
      );
      const result = await runToCompletion(['--dry-run', '--json', '--port', String(await freePort())], dir);
      assert.equal(result.code, 0, result.stderr);
      assert.match(parseEvents(result.stdout)[0]!.apps![0]!.command, /--bundler rspack /);
    }
  });
});

// --- --platform / --standalone (ODD dev-wizard-runner T4) --------------------

describe('dev --platform and --standalone', () => {
  // Prints what a `command` app can see, then listens on its runner port.
  const ENV_STUB = `console.log('env-stub ' + JSON.stringify({
    platform: process.env.ATLAS_APP_PLATFORM ?? null,
    standalone: process.env.ATLAS_APP_STANDALONE ?? null,
  }));
  require('net').createServer().listen(Number(process.env.ATLAS_APP_PORT), '127.0.0.1');
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  `;

  function workspaceWith(config: object, build: (dir: string) => void): string {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-plat-')));
    cleanupDirs.push(dir);
    writeFileSync(path.join(dir, 'env-stub.cjs'), ENV_STUB);
    build(dir);
    writeFileSync(path.join(dir, 'repack-federation.json'), JSON.stringify(config));
    return dir;
  }

  const rnArgs = (s: Session, app: string): string[] => {
    const line = s.lines.find((l) => l.startsWith(`[${app}] rn-stub `))!;
    assert.ok(line, `no rn-stub line for ${app}: ${s.lines.join('\n')}`);
    return (JSON.parse(line.slice(`[${app}] rn-stub `.length)) as { args: string[] }).args;
  };
  const envSeen = (s: Session, app: string): { platform: string | null; standalone: string | null } => {
    const line = s.lines.find((l) => l.startsWith(`[${app}] env-stub `))!;
    assert.ok(line, `no env-stub line for ${app}: ${s.lines.join('\n')}`);
    return JSON.parse(line.slice(`[${app}] env-stub `.length));
  };

  const mixed = () =>
    workspaceWith(
      {
        host: { manifest: './h.json', root: './apps/host' },
        remotes: {
          solo: { manifest: './s.json', root: './apps/solo', standalone: true },
          cmd: { manifest: './c.json', command: 'node env-stub.cjs', standalone: true },
          other: { manifest: './o.json', command: 'node env-stub.cjs' },
        },
      },
      (d) => {
        makeApp(d, 'apps/host');
        makeApp(d, 'apps/solo');
      }
    );

  for (const bad of ['web', 'IOS']) {
    it(`--platform ${JSON.stringify(bad)} exits 2 and spawns nothing`, async () => {
      const dir = mixed();
      const result = await runToCompletion(
        ['--ci', '--json', '--no-studio', '--platform', bad, '--port', String(await freePort())],
        dir
      );
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /--platform must be one of: ios, android/);
      assert.doesNotMatch(result.stdout, /"event":"(app|plan)"/);
    });
  }

  it('--platform ios reaches every built argv and ATLAS_APP_PLATFORM every command app', async () => {
    const dir = mixed();
    const s = await session(
      ['--ci', '--json', '--no-studio', '--platform', 'ios', '--port', String(await freePort())],
      dir
    );
    for (const app of ['host', 'solo', 'cmd', 'other']) await s.waitForStatus(app, 'ready');
    const tail = ['--no-interactive', '--platform', 'ios'];
    assert.deepEqual(rnArgs(s, 'host').slice(-3), tail);
    assert.deepEqual(rnArgs(s, 'solo').slice(-3), tail);
    assert.equal(envSeen(s, 'cmd').platform, 'ios');
    assert.equal(envSeen(s, 'other').platform, 'ios');
    const plan = s.events.find((e) => e.event === 'plan')!.apps as unknown as PlanApp[];
    assert.ok(plan.every((a) => a.platform === 'ios'));
    // The command line itself is never rewritten.
    assert.equal(plan.find((a) => a.app === 'cmd')!.command, 'node env-stub.cjs');
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('without --platform nothing is forwarded and the env var stays unset', async () => {
    const dir = mixed();
    const s = await session(
      ['--ci', '--json', '--no-studio', '--apps', 'host,other', '--port', String(await freePort())],
      dir
    );
    await s.waitForStatus('other', 'ready');
    await s.waitForStatus('host', 'ready');
    assert.ok(!rnArgs(s, 'host').includes('--platform'));
    assert.deepEqual(envSeen(s, 'other'), { platform: null, standalone: null });
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('stray ATLAS_APP_PLATFORM / ATLAS_APP_STANDALONE from the shell are not inherited', async () => {
    const dir = mixed();
    const s = await session(
      ['--ci', '--json', '--no-studio', '--apps', 'other', '--port', String(await freePort())],
      dir,
      { ATLAS_APP_PLATFORM: 'android', ATLAS_APP_STANDALONE: '1' }
    );
    await s.waitForStatus('other', 'ready');
    assert.deepEqual(envSeen(s, 'other'), { platform: null, standalone: null });
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('--standalone adds the remote to an --apps session; only it gets the flag / env', async () => {
    const dir = mixed();
    const s = await session(
      ['--ci', '--json', '--no-studio', '--apps', 'host', '--standalone', 'solo', '--port', String(await freePort())],
      dir
    );
    await s.waitForStatus('host', 'ready');
    await s.waitForStatus('solo', 'ready');
    assert.ok(!rnArgs(s, 'host').includes('--standalone'));
    assert.equal(rnArgs(s, 'solo').at(-1), '--standalone');
    const plan = s.events.find((e) => e.event === 'plan')!.apps as unknown as PlanApp[];
    assert.deepEqual(
      plan.map((a) => [a.app, a.standalone]),
      [
        ['host', undefined],
        ['solo', true],
      ]
    );
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('a standalone `command` remote gets ATLAS_APP_STANDALONE=1 and the others do not', async () => {
    const dir = mixed();
    const s = await session(
      ['--ci', '--json', '--no-studio', '--apps', 'cmd,other', '--standalone', 'cmd', '--port', String(await freePort())],
      dir
    );
    await s.waitForStatus('cmd', 'ready');
    await s.waitForStatus('other', 'ready');
    assert.equal(envSeen(s, 'cmd').standalone, '1');
    assert.equal(envSeen(s, 'other').standalone, null);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('--standalone gate: unknown remote and remote without standalone: true exit 2, nothing spawned', async () => {
    const dir = mixed();
    for (const [remote, message] of [
      ['ghost', /--standalone names an unknown remote: ghost/],
      ['other', /--standalone refused: remote "other" does not declare standalone support\. Set "standalone": true for it in .*repack-federation\.json/],
      ['host', /unknown remote: host/],
    ] as const) {
      for (const args of [['--dry-run'], ['--ci', '--json', '--no-studio']]) {
        const result = await runToCompletion(
          [...args, '--standalone', remote, '--port', String(await freePort())],
          dir
        );
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, message);
        assert.doesNotMatch(result.stdout, /"event":"app"/);
        assert.ok(!result.stdout.includes('rn-stub'), 'nothing spawned');
      }
    }
  });

  it('--standalone on a Re.Pack 5.x start (no such option) exits 2 naming the app, nothing spawned', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-sa5-')));
    cleanupDirs.push(dir);
    writeFileSync(
      path.join(dir, 'repack-federation.json'),
      JSON.stringify({
        host: { manifest: './h.json', root: './apps/host' },
        remotes: { solo: { manifest: './s.json', root: './apps/solo', standalone: true } },
      })
    );
    makeApp(dir, 'apps/host', { repack: 'repack5' });
    makeApp(dir, 'apps/solo', { repack: 'repack5' });
    for (const args of [['--dry-run'], ['--ci', '--json', '--no-studio']]) {
      const result = await runToCompletion(
        [...args, '--standalone', 'solo', '--port', String(await freePort())],
        dir
      );
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /solo: --standalone refused: the installed Re\.Pack's start command has no --standalone option/);
      assert.ok(!result.stdout.includes('rn-stub'), 'nothing spawned');
    }
  });

  it('--standalone without a value exits 2', async () => {
    const result = await runToCompletion(['--dry-run', '--standalone'], mixed());
    assert.equal(result.code, 2);
    assert.match(result.stderr, /dev: --standalone requires a value/);
    assert.equal(result.stdout, '', 'no plan, nothing spawned');
  });

  it('dry-run shows platform and standalone in the table and the additive plan fields', async () => {
    const dir = mixed();
    const port = String(await freePort());
    const table = await runToCompletion(
      ['--dry-run', '--platform', 'android', '--standalone', 'cmd', '--port', port],
      dir
    );
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /^app\s+role\s+port\s+platform\s+command\s+cwd$/m);
    assert.match(table.stdout, /^cmd\s+remote \(standalone\)\s+auto\s+android\s+node env-stub\.cjs/m);
    const json = await runToCompletion(
      ['--dry-run', '--json', '--platform', 'android', '--standalone', 'solo', '--port', port],
      dir
    );
    const apps = parseEvents(json.stdout)[0]!.apps as unknown as PlanApp[];
    assert.equal(apps.find((a) => a.app === 'solo')!.standalone, true);
    assert.equal(apps.find((a) => a.app === 'host')!.standalone, undefined);
    assert.match(apps.find((a) => a.app === 'solo')!.command, /--platform android --standalone$/);
  });

  it('two apps declaring the same port are a conflict: exit 1, nothing spawned (live and dry-run)', async () => {
    // Held together, so the two ports are guaranteed distinct (two
    // sequential freePort() calls may hand back the same number).
    const held = await occupyPorts(2);
    await held.close();
    const [shared, hostPort] = held.ports as [number, number];
    const dir = workspaceWith(
      {
        host: { manifest: './h.json', command: 'node env-stub.cjs', port: hostPort },
        remotes: {
          a: { manifest: './a.json', command: 'node env-stub.cjs', port: shared },
          b: { manifest: './b.json', command: 'node env-stub.cjs', port: shared },
        },
      },
      () => {}
    );
    for (const args of [['--dry-run'], ['--ci', '--json', '--no-studio']]) {
      const result = await runToCompletion(args, dir);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, new RegExp(`port ${shared} is declared by both a and b`));
      assert.doesNotMatch(result.stdout, /"event":"app"/);
      assert.ok(!result.stdout.includes('env-stub {'), 'nothing spawned');
    }
  });

  it('--auto-ports makes the reassignment visible in --json (plan and app events)', async () => {
    const held = await occupyPorts(1);
    const dir = workspaceWith(
      {
        host: { manifest: './h.json', command: 'node env-stub.cjs', port: held.ports[0] },
        remotes: {},
      },
      () => {}
    );
    try {
      const s = await session(['--ci', '--json', '--no-studio', '--auto-ports'], dir);
      const ready = await s.waitForStatus('host', 'ready');
      const plan = s.events.find((e) => e.event === 'plan')!.apps as unknown as PlanApp[];
      assert.equal(plan[0]!.reassignedFrom, held.ports[0]);
      assert.equal(
        (ready as DevEvent & { reassignedFrom?: number }).reassignedFrom,
        held.ports[0]
      );
      s.child.kill('SIGINT');
      assert.equal((await s.exited).code, 0);
    } finally {
      await held.close();
    }
  });
});

// --- --launch / --device (ODD dev-wizard-runner T5) --------------------------

describe('dev --launch', () => {
  function workspaceWith(config: object, build: (dir: string) => void): string {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-launch-')));
    cleanupDirs.push(dir);
    build(dir);
    writeFileSync(path.join(dir, 'repack-federation.json'), JSON.stringify(config));
    return dir;
  }

  /** Host + a standalone-capable remote, both with the stub react-native. */
  const rooted = () =>
    workspaceWith(
      {
        host: { manifest: './h.json', root: './apps/host' },
        remotes: {
          solo: { manifest: './s.json', root: './apps/solo', standalone: true },
        },
      },
      (d) => {
        makeApp(d, 'apps/host');
        makeApp(d, 'apps/solo');
      }
    );

  const launchLog = (dir: string, app: string): string[][] => {
    const file = path.join(dir, 'apps', app, 'launch.log');
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as string[])
      : [];
  };

  async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      assert.ok(Date.now() < deadline, `timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const base = async () => ['--ci', '--json', '--no-studio', '--port', String(await freePort())];

  it('--launch runs run-<platform> through the shim when the target has one', async () => {
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => makeApp(d, 'apps/host', { shim: true })
    );
    const s = await session(
      [...(await base()), '--platform', 'ios', '--launch'],
      dir
    );
    await s.waitForEvent((e) => e.event === 'launch' && e.status === 'exited');
    assert.deepEqual(launchLog(dir, 'host'), [['run-ios', '--no-packager']]);
    assert.equal(
      readFileSync(path.join(dir, 'apps', 'host', 'launch.env'), 'utf8').trim(),
      '1',
      'the one-shot ran through the shim'
    );
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.equal(plan.launch!.command, 'node_modules/.bin/react-native run-ios --no-packager');
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('--launch --platform ios spawns run-ios --no-packager exactly once, after the host is ready', async () => {
    const dir = rooted();
    const s = await session(
      [...(await base()), '--apps', 'host', '--platform', 'ios', '--launch'],
      dir
    );
    const exited = await s.waitForEvent(
      (e) => e.event === 'launch' && e.status === 'exited'
    );
    assert.equal(exited.code, 0);
    // Let several readiness polls pass: a second spawn would append a line.
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(launchLog(dir, 'host'), [['run-ios', '--no-packager']]);
    const kinds = s.events.map((e) =>
      e.event === 'app' ? `app:${e.status}` : e.event
    );
    assert.ok(
      kinds.indexOf('app:ready') < kinds.indexOf('launch'),
      `launch must follow readiness: ${kinds.join(',')}`
    );
    assert.equal(kinds.filter((k) => k === 'launch').length, 2, 'started + exited');
    assert.ok(
      s.lines.some((l) => l.startsWith('[launch] launch-stub ["run-ios","--no-packager"]')),
      'launch output is [launch]-prefixed'
    );
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.equal(plan.launch!.app, 'host');
    assert.equal(
      plan.launch!.command,
      'node node_modules/react-native/cli.js run-ios --no-packager'
    );
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('--device rides verbatim to run-<platform>', async () => {
    const dir = rooted();
    const s = await session(
      [...(await base()), '--apps', 'host', '--platform', 'android', '--launch', '--device', 'emulator-5554'],
      dir
    );
    await s.waitForEvent((e) => e.event === 'launch' && e.status === 'exited');
    assert.deepEqual(launchLog(dir, 'host'), [
      ['run-android', '--no-packager', '--device', 'emulator-5554'],
    ]);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('a standalone session launches from the standalone remote, on its readiness', async () => {
    const dir = rooted();
    const s = await session(
      [...(await base()), '--apps', 'host', '--standalone', 'solo', '--platform', 'ios', '--launch'],
      dir
    );
    await s.waitForEvent((e) => e.event === 'launch' && e.status === 'exited');
    assert.deepEqual(launchLog(dir, 'solo'), [['run-ios', '--no-packager']]);
    assert.deepEqual(launchLog(dir, 'host'), []);
    const plan = s.events.find((e) => e.event === 'plan')!;
    assert.equal(plan.launch!.app, 'solo');
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('a target with a `command` override still launches through its root\'s cli', async () => {
    const hostPort = await freePort();
    const dir = workspaceWith(
      {
        host: {
          manifest: './h.json',
          root: './apps/host',
          command:
            "node -e \"require('net').createServer().listen(Number(process.env.ATLAS_APP_PORT),'127.0.0.1')\"",
        },
        remotes: {},
      },
      (d) => makeApp(d, 'apps/host')
    );
    const s = await session(
      ['--ci', '--json', '--no-studio', '--port', String(hostPort), '--platform', 'ios', '--launch'],
      dir
    );
    await s.waitForEvent((e) => e.event === 'launch' && e.status === 'exited');
    assert.deepEqual(launchLog(dir, 'host'), [['run-ios', '--no-packager']]);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('a failing launch is reported but never fails the session', async () => {
    const dir = rooted();
    mkdirSync(path.join(dir, 'apps', 'host'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'host', 'launch-mode'), 'fail');
    const s = await session(
      [...(await base()), '--apps', 'host', '--platform', 'ios', '--launch'],
      dir
    );
    const failed = await s.waitForEvent(
      (e) => e.event === 'launch' && e.status === 'exited'
    );
    assert.equal(failed.code, 1);
    await waitFor(
      () => s.lines.some((l) => l.includes('dev: launch exited with code 1')),
      'the human failure line'
    );
    assert.ok(s.lines.some((l) => l.startsWith('[launch] launch-stub failing')));
    // The host is still up and the session is healthy.
    assert.ok(!s.events.some((e) => e.event === 'app' && e.status === 'error'));
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
    assert.equal(s.events.at(-1)!.code, 0);
  });

  it('shutdown kills a launch that is still running', async () => {
    const dir = rooted();
    writeFileSync(path.join(dir, 'apps', 'host', 'launch-mode'), 'hang');
    const s = await session(
      [...(await base()), '--apps', 'host', '--platform', 'ios', '--launch'],
      dir
    );
    const pidFile = path.join(dir, 'apps', 'host', 'launch.pid');
    await waitFor(() => existsSync(pidFile), 'the hanging launch to start');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(processAlive(pid));
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
    await waitGroupGone(pid);
    assert.ok(
      !s.events.some((e) => e.event === 'launch' && e.status === 'exited'),
      'a kill by shutdown is not reported as a launch failure'
    );
  });

  it('--launch without a platform exits 2 and spawns nothing', async () => {
    const dir = rooted();
    for (const args of [['--dry-run'], ['--ci', '--json', '--no-studio']]) {
      const result = await runToCompletion([...args, '--launch', '--port', String(await freePort())], dir);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /--launch needs a single platform/);
      assert.doesNotMatch(result.stdout, /"event":"(plan|app)"/);
      assert.deepEqual(launchLog(dir, 'host'), []);
    }
  });

  it('--launch with --no-launch exits 2', async () => {
    const result = await runToCompletion(
      ['--dry-run', '--platform', 'ios', '--launch', '--no-launch'],
      rooted()
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--launch and --no-launch cannot be combined/);
  });

  it('a launch target outside the session or without a root exits 2, nothing spawned', async () => {
    const dir = rooted();
    const outside = await runToCompletion(
      [...(await base()), '--apps', 'solo', '--platform', 'ios', '--launch'],
      dir
    );
    assert.equal(outside.code, 2, outside.stderr);
    assert.match(outside.stderr, /needs the host \(or the --standalone remote\)/);
    const rootless = workspaceWith(
      { host: { manifest: './h.json', command: 'true' }, remotes: {} },
      () => {}
    );
    const noRoot = await runToCompletion(
      [...(await base()), '--platform', 'ios', '--launch'],
      rootless
    );
    assert.equal(noRoot.code, 2, noRoot.stderr);
    assert.match(noRoot.stderr, /host declares no "root"/);
    assert.doesNotMatch(outside.stdout + noRoot.stdout, /"event":"(plan|app)"/);
  });

  it('a target whose react-native cli is missing exits 2', async () => {
    const dir = workspaceWith(
      { host: { manifest: './h.json', root: './apps/host' }, remotes: {} },
      (d) => makeApp(d, 'apps/host', { rn: false })
    );
    const result = await runToCompletion(
      [...(await base()), '--platform', 'ios', '--launch'],
      dir
    );
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /cannot resolve the "react-native" package/);
  });

  it('without --launch nothing launches (--device alone only warns)', async () => {
    const dir = rooted();
    const s = await session(
      [...(await base()), '--apps', 'host', '--platform', 'ios', '--device', 'x'],
      dir
    );
    await s.waitForStatus('host', 'ready');
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(launchLog(dir, 'host'), []);
    assert.ok(!s.events.some((e) => e.event === 'launch'));
    assert.equal(s.events.find((e) => e.event === 'plan')!.launch, undefined);
    assert.ok(s.lines.some((l) => l.includes('--device is ignored without --launch')));
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('--no-launch is accepted and launches nothing', async () => {
    const dir = rooted();
    const s = await session(
      [...(await base()), '--apps', 'host', '--platform', 'ios', '--no-launch'],
      dir
    );
    await s.waitForStatus('host', 'ready');
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(launchLog(dir, 'host'), []);
    s.child.kill('SIGINT');
    assert.equal((await s.exited).code, 0);
  });

  it('dry-run shows the launch (table + additive plan field), spawns nothing and is byte-stable', async () => {
    const dir = rooted();
    const args = ['--dry-run', '--apps', 'host', '--platform', 'android', '--launch', '--device', 'pixel', '--port', String(await freePort())];
    const table = await runToCompletion(args, dir);
    assert.equal(table.code, 0, table.stderr);
    assert.match(
      table.stdout,
      /^launch \(once host is ready\): node node_modules\/react-native\/cli\.js run-android --no-packager --device pixel {2}\[cwd .*apps\/host\]$/m
    );
    const first = await runToCompletion([...args, '--json'], dir);
    const second = await runToCompletion([...args, '--json'], dir);
    assert.equal(first.stdout, second.stdout, 'byte-identical across runs');
    const plan = parseEvents(first.stdout)[0]!;
    assert.deepEqual(plan.launch, {
      app: 'host',
      command: 'node node_modules/react-native/cli.js run-android --no-packager --device pixel',
      cwd: path.join(dir, 'apps', 'host'),
    });
    assert.deepEqual(launchLog(dir, 'host'), [], 'dry-run spawns nothing');
    const plain = await runToCompletion(
      ['--dry-run', '--json', '--apps', 'host', '--port', String(await freePort())],
      dir
    );
    assert.equal(parseEvents(plain.stdout)[0]!.launch, undefined);
  });
});
