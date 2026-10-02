// Orphan dev-server recovery (ODD dev-port-conflict-warn-kill T3). When a
// hard parent death leaves a spawned `react-native start` parentless, it
// keeps holding its port and the next `dev` run dead-ends on a conflict.
// This module offers the human a way out — but ONLY for an owner that is
// provably an orphaned dev server of THIS workspace:
//
//   PPID === 1 (reparented to init: its Atlas/CLI parent died) AND its
//   command line references an app dir of the resolved config workspace.
//
// Anything else (another user's process, a live server, an unknown owner)
// gets NO offer: the caller keeps today's exact error path. Honesty rule 7:
// the "of this workspace" claim is made only when the argv actually matched
// a workspace app dir. `portOwner` degrading to null (Windows, no lsof)
// means "no offer", never a guess.

import type { PromptPort } from '../core/index.js';
import {
  formatOwnerCommand,
  type PortOwnerInfo,
  type PortProbe,
  type PortOwnership,
} from './ports.js';

/** The orphan signature: reparented AND this workspace's own command. */
export function isWorkspaceOrphan(
  owner: PortOwnerInfo,
  appDirs: readonly string[]
): boolean {
  return (
    owner.ppid === 1 && appDirs.some((dir) => owner.command.includes(dir))
  );
}

/** The kill question: PID + trimmed command, the claim earned by the match. */
export function killQuestion(port: number, owner: PortOwnerInfo): string {
  return (
    `Port ${port} is held by an orphaned dev server of this workspace ` +
    `(pid ${owner.pid}: ${formatOwnerCommand(owner.command)}). Kill it?`
  );
}

/** One line per confirmed kill, for the caller to report. */
export function describeKill(port: number, owner: PortOwnerInfo): string {
  return `killed orphaned dev server on port ${port} (pid ${owner.pid})`;
}

export interface OrphanKillOptions {
  /** Busy ports the allocation could not claim, in plan order. */
  busyPorts: readonly number[];
  /** App dirs of THIS workspace (plan entry roots / cwds). */
  appDirs: readonly string[];
  ownership: PortOwnership;
  probe: PortProbe;
  prompts: PromptPort;
  /** Bounds for waiting a killed process releases its port. */
  waitFreeTimeoutMs?: number;
  pollMs?: number;
}

export type OrphanKillOutcome =
  /** Every conflicting port's orphan was confirmed, terminated, and freed. */
  | { status: 'killed'; notes: string[] }
  /** No kill was offered or completed: keep the old error path untouched. */
  | { status: 'unavailable' }
  /** The user declined (or cancelled) at least one kill. */
  | { status: 'declined' };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve each conflicting port's owner; offer a kill ONLY while every owner
 * is a workspace orphan; on yes SIGTERM, wait (bounded) for the port to
 * free. Returns `killed` only when ALL ports freed — the caller then retries
 * its plan ONCE. Every failure shape lands on `unavailable`/`declined`,
 * which the caller renders as today's error path.
 */
export async function offerOrphanKills(
  options: OrphanKillOptions
): Promise<OrphanKillOutcome> {
  const waitFreeTimeoutMs = options.waitFreeTimeoutMs ?? 2_000;
  const pollMs = options.pollMs ?? 100;
  if (options.busyPorts.length === 0) return { status: 'unavailable' };

  const owners: Array<{ port: number; owner: PortOwnerInfo }> = [];
  for (const port of options.busyPorts) {
    let owner: PortOwnerInfo | null = null;
    try {
      owner = await options.ownership.portOwner(port);
    } catch {
      owner = null;
    }
    // Unknown owner, or one not clearly this workspace's orphan: no offer.
    if (owner === null || !isWorkspaceOrphan(owner, options.appDirs)) {
      return { status: 'unavailable' };
    }
    owners.push({ port, owner });
  }

  const notes: string[] = [];
  for (const { port, owner } of owners) {
    const answer = await options.prompts.confirm({
      message: killQuestion(port, owner),
      initialValue: false,
    });
    if (answer.status === 'cancelled' || !answer.value) {
      return { status: 'declined' };
    }
    if (!options.ownership.terminate(owner.pid)) {
      return { status: 'unavailable' };
    }
    // Bounded wait for the port to actually free; a zombie that keeps the
    // socket held lands on the old error path, never a hung session.
    const deadline = Date.now() + waitFreeTimeoutMs;
    let freed = false;
    while (Date.now() <= deadline) {
      try {
        if (!(await options.probe.isPortBusy(port))) {
          freed = true;
          break;
        }
      } catch {
        // A failing probe cannot vouch for freeness: keep polling.
      }
      await sleep(pollMs);
    }
    if (!freed) return { status: 'unavailable' };
    notes.push(describeKill(port, owner));
  }
  return { status: 'killed', notes };
}
