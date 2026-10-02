// `ProcessRunner` node adapter (docs/PRD.md §6.1, R7): spawn children in
// their own process group so shutdown cannot leave orphans, expose stdout/
// stderr as line-wise subscriptions, and answer port questions with hard
// timeouts. The T9 runner supervisor is the designed consumer; nothing here
// knows about bundlers.
//
// Provenance: the busy-probe is ported from `isPortBusy`/`canConnect`/
// `answersStatus`/`getFreePort` of `commands/federation/portPlanner.ts`
// (callstack/repack branch `feat/federation-dev-runner` @ that branch's
// base of c5df67f0): two independent legs (TCP connect, any HTTP answer),
// 127.0.0.1 only, ~150 ms timeouts per leg — a probe that never answers is
// classified free, never left open. Kill-tree replaces the upstream
// supervisor's execa child handling: SIGINT → grace → SIGTERM to the
// negative pid (process group), the POSIX way to catch grandchildren the
// `react-native start`-style wrappers spawn.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type {
  ProcessHandle,
  ProcessRunner,
  SpawnSpec,
} from '../core/ports.js';
import type { PortOwnership } from '../runner/ports.js';
import { createNodePortOwnership } from './port-owner.js';

const TCP_CONNECT_TIMEOUT_MS = 150;
const STATUS_PROBE_TIMEOUT_MS = 150;
const DEFAULT_KILL_GRACE_MS = 5_000;

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(TCP_CONNECT_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

function answersAnyHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        timeout: STATUS_PROBE_TIMEOUT_MS,
      },
      (response) => {
        // ANY response is a positive answer — busy-ness is binary here.
        response.destroy();
        resolve(true);
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

/** Split a stream chunk buffer into lines without losing partial data. */
function createLineSplitter(emit: (line: string) => void) {
  let pending = '';
  return (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      emit(pending.slice(0, index).replace(/\r$/, ''));
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
  };
}

/** The node ProcessRunner plus the composed port-ownership capability. */
export type NodeProcessRunner = ProcessRunner & PortOwnership;

export function createNodeProcessRunner(): NodeProcessRunner {
  const runner: ProcessRunner = {
    start(spec: SpawnSpec): ProcessHandle {
      const stdoutListeners = new Set<(chunk: string) => void>();
      const stderrListeners = new Set<(chunk: string) => void>();
      const stdoutSplit = createLineSplitter((line) =>
        stdoutListeners.forEach((l) => l(line))
      );
      const stderrSplit = createLineSplitter((line) =>
        stderrListeners.forEach((l) => l(line))
      );

      const env = spec.env ? { ...process.env, ...spec.env } : process.env;
      // `undefined` means "remove": spawn would stringify it otherwise.
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete env[key];
      }

      const child = spawn(spec.file, spec.args ?? [], {
        cwd: spec.cwd,
        env,
        shell: spec.shell ?? false,
        ...(spec.windowsVerbatimArguments === true
          ? { windowsVerbatimArguments: true }
          : {}),
        // Own process group (POSIX): the group leader's pid == child pid,
        // so `kill(-pid)` reaches every descendant, not just the child.
        // Windows ignores this and killTree degrades to a direct kill.
        detached: process.platform !== 'win32',
        // stdin is PIPED, not ignored: the dev TUI's typed input (F12)
        // writes to `child.stdin` through `writeStdin`. Children that never
        // read stdin are unaffected; a child that does now waits on the
        // pipe instead of getting an instant EOF — the TUI's send-line is
        // the only writer.
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => stdoutSplit(chunk));
      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => stderrSplit(chunk));
      // With stdin piped (F12), writing after the child died surfaces as an
      // EPIPE 'error' on the stream. Node throws on an unhandled one, so the
      // listener must exist; `writeStdin` reports the failure as `false`.
      child.stdin?.on('error', () => {});

      let settled = false;
      const exited: Promise<{ code: number | null; signal: string | null }> =
        new Promise((resolve) => {
          child.once('close', (code, signal) => {
            settled = true;
            resolve({ code, signal });
          });
          // Spawn failure (ENOENT …) surfaces as 'error' + no exit; resolve
          // with a synthetic failure so waitForExit never hangs.
          child.once('error', () => {
            settled = true;
            resolve({ code: null, signal: 'spawn-error' });
          });
        });

      function signalGroup(signal: NodeJS.Signals): void {
        if (child.pid === undefined) return;
        try {
          if (process.platform !== 'win32') {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // ESRCH: the group already exited — killing a dead tree is a no-op.
        }
      }

      /** Any process left in the child's group? (Windows: the child alone.) */
      function groupAlive(): boolean {
        if (child.pid === undefined) return false;
        if (process.platform === 'win32') return !settled;
        try {
          // Signal 0 = existence probe. On POSIX the negative pid queries
          // the whole group, so a SIGINT-ignoring grandchild counts.
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      }

      async function waitGroupGone(budgetMs: number): Promise<void> {
        const deadline = Date.now() + budgetMs;
        while (groupAlive() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      return {
        get pid(): number | null {
          return child.pid ?? null;
        },
        subscribeToStdout(listener) {
          stdoutListeners.add(listener);
          return () => stdoutListeners.delete(listener);
        },
        subscribeToStderr(listener) {
          stderrListeners.add(listener);
          return () => stderrListeners.delete(listener);
        },
        writeStdin(data) {
          // F12 typed input: bytes go to the child's piped stdin verbatim
          // (the caller appends the newline). False when stdin is gone —
          // closed, errored, or the child already exited.
          const stdin = child.stdin;
          if (stdin === null || !stdin.writable) return false;
          try {
            stdin.write(data);
            return true;
          } catch {
            return false;
          }
        },
        waitForExit() {
          return exited;
        },
        signal(signal) {
          try {
            child.kill(signal);
          } catch {
            /* already dead */
          }
        },
        async killTree(graceMs = DEFAULT_KILL_GRACE_MS): Promise<void> {
          if (settled && !groupAlive()) return;
          signalGroup('SIGINT');
          const grace = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, graceMs);
            void exited.then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
          await grace;
          // The child may be gone while a SIGINT-ignoring descendant lingers
          // in the group: escalate until the whole group is dead.
          if (groupAlive()) signalGroup('SIGTERM');
          await exited;
          await waitGroupGone(2_000);
        },
      };
    },

    async isPortBusy(port: number): Promise<boolean> {
      if (await canConnect(port)) return true;
      return answersAnyHttp(port);
    },

    findFreePort(): Promise<number> {
      return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as net.AddressInfo;
          server.close(() => resolve(port));
        });
      });
    },
  };
  // Owner lookup + confirmed-orphan SIGTERM ride the same runner (ODD
  // dev-port-conflict-warn-kill T1): one object answers every port question.
  return { ...runner, ...createNodePortOwnership(runner) };
}
