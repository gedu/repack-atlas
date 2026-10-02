// Port allocation for `repack-atlas dev` (ODD dev-wizard-runner T2). The
// probes are injected, so the conflict and reassignment rules are unit-testable
// without sockets; `supervisor.ts` and the `--dry-run` path wire the real
// `ProcessRunner` into them. Policy (upstream #1467 `portPlanner`): a busy
// declared port is a conflict; with `autoPorts` it is reassigned to a free
// port instead; without it ALL conflicts are collected and reported together.
// Atlas goes one step past upstream here: two apps declaring the SAME port are
// a conflict too (upstream probes each independently, so both look free and
// the second bind fails at runtime).

import type { DevPlanEntry } from './plan.js';

/** The two socket questions the allocator asks (`ProcessRunner` satisfies it). */
export interface PortProbe {
  isPortBusy(port: number): Promise<boolean>;
  findFreePort(): Promise<number>;
}

/**
 * The process listening on a port, as `ps` reports it (owner probe, ODD
 * dev-port-conflict-warn-kill T1). `ppid === 1` means the process was
 * reparented — the orphan signature the dev runner offers to clean up.
 */
export interface PortOwnerInfo {
  pid: number;
  ppid: number;
  /** Full command line (argv, not just the executable). */
  command: string;
}

/**
 * The "who holds this port?" question, kept OUT of `PortProbe` on purpose:
 * busy/free probing works everywhere, owner lookup may degrade to unknown
 * (Windows, no `lsof`, another user's process) and every caller must handle
 * `null` as "busy, owner unknown" — never a guess.
 */
export interface PortOwnerProbe {
  portOwner(port: number): Promise<PortOwnerInfo | null>;
}

/**
 * SIGTERM one pid the human flow explicitly confirmed killing (an orphan of
 * THIS workspace — see `orphanCandidate`). Returns whether the signal was
 * delivered; "already gone" counts as false and simply falls through to the
 * old error path. Wrapped (wrapper rule 3) so tests fake it instead of
 * signalling real processes.
 */
export interface ProcessTerminator {
  terminate(pid: number): boolean;
}

/** Everything the human orphan flow needs from the OS side. */
export type PortOwnership = PortOwnerProbe & ProcessTerminator;

export interface PortAssignment {
  key: string;
  /** `null` only for unmanaged remotes of a dry-run (shown as `auto`). */
  port: number | null;
  /** `reassigned`: the declared/default port was busy and `--auto-ports` moved it. */
  source: 'declared' | 'auto' | 'reassigned';
  /** The busy (or already-claimed) port a `reassigned` app gave up. */
  requested?: number;
}

export interface AllocatePortsOptions {
  /** `--auto-ports`: busy declared ports move to a free port. */
  autoPorts: boolean;
  /** Pick a free port for apps without one. `false` (dry-run) leaves `null`. */
  resolveAuto: boolean;
}

export type PortAllocation =
  | { ok: true; assignments: PortAssignment[] }
  | {
      ok: false;
      conflicts: string[];
      /** Additive (ODD dev-port-conflict-warn-kill): the subset of conflicts
       * caused by a BUSY declared port — the only ones the human-path orphan
       * flow can act on. Absent when none. */
      busyPorts?: number[];
    };

const MAX_FREE_PORT_TRIES = 10;

/**
 * Probe every entry in plan order. Returns one assignment per entry, or all
 * conflicts when a declared port is busy and `autoPorts` is off. Never binds.
 */
export async function allocatePorts(
  entries: DevPlanEntry[],
  probe: PortProbe,
  options: AllocatePortsOptions
): Promise<PortAllocation> {
  const assignments: PortAssignment[] = [];
  const conflicts: string[] = [];
  /** Declared ports found busy that ended the allocation (owner-flow input). */
  const busyPorts: number[] = [];
  // Ports already promised to an app; a fresh "free" port must avoid them.
  const taken = new Set(
    entries.flatMap((entry) =>
      entry.declaredPort !== null ? [entry.declaredPort] : []
    )
  );

  // Declared ports already handed to an earlier app of this plan.
  const claimed = new Map<number, string>();

  /** A probe that throws cannot vouch for the port: busy, never a crash. */
  async function isBusy(port: number): Promise<boolean> {
    try {
      return await probe.isPortBusy(port);
    } catch {
      return true;
    }
  }

  /** A free port not promised to another app, or `null` (never throws). */
  async function nextFree(): Promise<number | null> {
    try {
      for (let attempt = 0; attempt < MAX_FREE_PORT_TRIES; attempt += 1) {
        const port = await probe.findFreePort();
        if (!taken.has(port)) {
          taken.add(port);
          return port;
        }
      }
    } catch {
      // A failing probe is "no free port", reported like any other conflict.
    }
    return null;
  }

  for (const entry of entries) {
    if (entry.declaredPort === null) {
      if (!options.resolveAuto) {
        assignments.push({ key: entry.key, port: null, source: 'auto' });
        continue;
      }
      const port = await nextFree();
      if (port === null) {
        conflicts.push(`no free port available for ${entry.key}`);
      } else {
        assignments.push({ key: entry.key, port, source: 'auto' });
      }
      continue;
    }
    const claimedBy = claimed.get(entry.declaredPort);
    if (
      claimedBy === undefined &&
      !(await isBusy(entry.declaredPort))
    ) {
      claimed.set(entry.declaredPort, entry.key);
      assignments.push({
        key: entry.key,
        port: entry.declaredPort,
        source: 'declared',
      });
    } else if (options.autoPorts) {
      const port = await nextFree();
      if (port === null) {
        conflicts.push(
          `port ${entry.declaredPort} declared by ${entry.key} is busy and no free port is available`
        );
      } else {
        assignments.push({
          key: entry.key,
          port,
          source: 'reassigned',
          requested: entry.declaredPort,
        });
      }
    } else if (claimedBy !== undefined) {
      conflicts.push(
        `port ${entry.declaredPort} is declared by both ${claimedBy} and ${entry.key}`
      );
    } else {
      conflicts.push(
        `port ${entry.declaredPort} declared by ${entry.key} is already busy`
      );
      busyPorts.push(entry.declaredPort);
    }
  }

  return conflicts.length > 0
    ? {
        ok: false,
        conflicts,
        ...(busyPorts.length > 0 ? { busyPorts } : {}),
      }
    : { ok: true, assignments };
}

/**
 * Plan entries with the allocated ports recorded as `allocatedPort` (for the
 * plan event/table); `declaredPort` keeps meaning "what the plan asked for".
 */
export function applyAssignments(
  entries: DevPlanEntry[],
  assignments: PortAssignment[]
): DevPlanEntry[] {
  const byKey = new Map(assignments.map((a) => [a.key, a]));
  return entries.map((entry) => {
    const assignment = byKey.get(entry.key);
    if (!assignment) return entry;
    return {
      ...entry,
      ...(assignment.port !== null ? { allocatedPort: assignment.port } : {}),
      ...(assignment.requested !== undefined
        ? { reassignedFrom: assignment.requested }
        : {}),
    };
  });
}

/** One human line per `--auto-ports` reassignment (stderr in human mode). */
export function describeReassignments(assignments: PortAssignment[]): string[] {
  return assignments
    .filter((a) => a.source === 'reassigned')
    .map(
      (a) =>
        `port ${a.requested} for ${a.key} was busy — using ${a.port} (--auto-ports)`
    );
}

/** Appended after a conflict report so the way out is always named. */
export const PORT_CONFLICT_HINT =
  'free the port(s), pass --port for the host, or use --auto-ports to reassign busy ports';

/**
 * Below this cap there is no room for both ends of a path, so the formatter
 * falls back to plain head-elision (what small-cap callers always asked for).
 */
const MIDDLE_ELISION_MIN_CAP = 40;
/** Room enough to identify a process: an executable plus its trailing flags. */
const MIN_TAIL_KEEP = 24;

/**
 * One line, capped: an owner command as shown inside a question or note.
 *
 * The cap is the contract (the result never exceeds `maxLength` and an
 * elision is always marked with `...`). What changed is WHERE it elides: what
 * identifies an owner is the END of its argv (`…/packages/host/…/cli.js start
 * --port 8081`), so an over-cap line keeps a short head and a long tail and
 * drops the middle. Before that, two cheap shortenings are tried in order —
 * `$HOME` → `~`, then a redundant leading `node ` — each of which can bring
 * the line under the cap with nothing elided at all. A command that already
 * fits comes back untouched (whitespace-collapsed), byte for byte.
 */
export function formatOwnerCommand(
  command: string,
  maxLength = 100,
  env: { HOME?: string } = process.env
): string {
  const collapsed = command.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;

  const home = env.HOME;
  let text = collapsed;
  if (home !== undefined && home !== '' && text.includes(home)) {
    text = text.split(home).join('~');
  }
  if (text.length <= maxLength) return text;
  if (text.startsWith('node ')) {
    text = text.slice('node '.length);
  }
  if (text.length <= maxLength) return text;

  const budget = maxLength - 3;
  if (maxLength < MIDDLE_ELISION_MIN_CAP || budget < MIN_TAIL_KEEP * 2) {
    return `${text.slice(0, budget)}...`;
  }
  // Head-weighted up to the point where it stops paying off: the head must
  // reach the workspace/project segment (`~/Documents/CK/super-app-showcase/`)
  // because that is what says WHICH session owns the port, and the tail keeps
  // the executable plus its flags (`…/cli.js start --port 8081`). The break
  // lands on a `/` boundary when one is near, so the visible head is whole
  // path segments and never half a directory name.
  const window = Math.floor((budget * 3) / 5);
  const breakAt = text.lastIndexOf('/', window);
  const head = breakAt >= 8 ? breakAt + 1 : window;
  return `${text.slice(0, head)}...${text.slice(text.length - (budget - head))}`;
}
