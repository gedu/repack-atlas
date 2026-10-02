// Node implementation of the `PortOwnership` port (ODD
// dev-port-conflict-warn-kill T1): answer "who listens on this busy port?"
// by spawning `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the listener pid and
// `ps -p <pid> -o ppid= -o command=` for the parent pid and full argv —
// both through the SAME `ProcessRunner` that spawns the apps (wrapper rule
// 3: process spawning stays behind the port; AGENTS rule 11: no new runtime
// dependencies). `createNodeProcessRunner` composes it so one object answers
// busy/free, owner, and the confirmed-orphan SIGTERM.
//
// Honest degradation to `null` ("busy, owner unknown") — never a guess:
// Windows has no lsof, the port may belong to another user (lsof cannot
// read its argv), the tools may be missing or slow, and a probe that fails
// must not be dressed up as an answer.

import type { ProcessRunner, SpawnSpec } from '../core/ports.js';
import type {
  PortOwnerInfo,
  PortOwnerProbe,
  PortOwnership,
} from '../runner/ports.js';

/** Both lookups are quick; a hung lsof answers "unknown", not a guess. */
const OWNER_QUERY_TIMEOUT_MS = 2_000;

interface CommandResult {
  ok: boolean;
  stdout: string;
}

/** Run a short-lived argv command to completion, capturing stdout. */
function runCommand(
  runner: ProcessRunner,
  spec: SpawnSpec
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ ok: false, stdout: '' }),
      OWNER_QUERY_TIMEOUT_MS
    );
    timer.unref();
    let handle;
    try {
      handle = runner.start(spec);
    } catch {
      settle({ ok: false, stdout: '' });
      return;
    }
    handle.subscribeToStdout((line) => {
      stdout += `${line}\n`;
    });
    void handle.waitForExit().then(({ code }) => {
      settle({ ok: code === 0, stdout });
    });
  });
}

/** First LISTEN line of `lsof -iTCP:<port>` output → its pid, or null. */
export function parseLsofPid(stdout: string): number | null {
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || fields[0] === 'COMMAND') continue;
    const pid = Number(fields[1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** `ps -p <pid> -o ppid= -o command=` line → { pid, ppid, command }, or null. */
export function parsePsOwner(
  pid: number,
  stdout: string
): PortOwnerInfo | null {
  const line = stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => /^\d+\s+\S/.test(candidate));
  if (line === undefined) return null;
  const ppid = Number(/^\d+/.exec(line)![0]);
  const command = line.slice(String(ppid).length).trim();
  if (!Number.isInteger(ppid) || ppid < 0 || command === '') return null;
  return { pid, ppid, command };
}

/** The owner-probe half: `lsof` + `ps` through `runner`. */
export function createPortOwnerProbe(
  runner: ProcessRunner
): PortOwnerProbe {
  return {
    async portOwner(port: number): Promise<PortOwnerInfo | null> {
      // No lsof on Windows: degrade without probing (the spawn would only
      // fail there).
      if (process.platform === 'win32') return null;
      const lsof = await runCommand(runner, {
        file: 'lsof',
        args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
      });
      if (!lsof.ok) return null;
      const pid = parseLsofPid(lsof.stdout);
      if (pid === null) return null;
      const ps = await runCommand(runner, {
        file: 'ps',
        // -ww: no output-width truncation (a long argv stays complete).
        args: ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'command='],
      });
      if (!ps.ok) return null;
      return parsePsOwner(pid, ps.stdout);
    },
  };
}

export function createNodePortOwnership(runner: ProcessRunner): PortOwnership {
  return {
    ...createPortOwnerProbe(runner),
    terminate(pid: number): boolean {
      // 0/-1 would signal OUR process group — never reachable from the flow
      // (pids come from lsof), but the guard belongs on the signal wrapper.
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try {
        // Reached only through the human orphan flow's explicit
        // confirmation (src/runner/orphan.ts).
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {
        // ESRCH (already gone) or EPERM (not ours): nothing was signalled.
        return false;
      }
    },
  };
}
