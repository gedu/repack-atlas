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
  | { ok: false; conflicts: string[] };

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
  // Ports already promised to an app; a fresh "free" port must avoid them.
  const taken = new Set(
    entries.flatMap((entry) =>
      entry.declaredPort !== null ? [entry.declaredPort] : []
    )
  );

  // Declared ports already handed to an earlier app of this plan.
  const claimed = new Map<number, string>();

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
      !(await probe.isPortBusy(entry.declaredPort))
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
    }
  }

  return conflicts.length > 0
    ? { ok: false, conflicts }
    : { ok: true, assignments };
}

/** Plan entries with the allocated ports written back (for the plan event/table). */
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
      declaredPort: assignment.port,
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
