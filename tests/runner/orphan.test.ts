// Orphan kill flow (ODD dev-port-conflict-warn-kill T3): pure unit tests over
// fake PortOwnership / PortProbe / PromptPort — no real pids, no signals, no
// sockets. The contract under test is the honesty ladder: an offer appears
// ONLY for an owner that is provably this workspace's orphan (PPID 1 AND an
// app dir in its argv), every kill is human-confirmed, and every failure
// shape lands on 'unavailable'/'declined' so the caller keeps the old,
// byte-identical error path.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PromptPort, PromptResult } from '../../src/core/index.js';
import {
  describeKill,
  isWorkspaceOrphan,
  killQuestion,
  offerOrphanKills,
  type OrphanKillOptions,
} from '../../src/runner/orphan.js';
import type {
  PortOwnerInfo,
  PortOwnership,
  PortProbe,
} from '../../src/runner/ports.js';

const APP_DIRS = ['/ws/apps/host', '/ws/apps/alpha'];

const orphan = (
  pid: number,
  overrides: Partial<PortOwnerInfo> = {}
): PortOwnerInfo => ({
  pid,
  ppid: 1,
  command: `node /ws/apps/host/node_modules/react-native/cli.js start --port 8081`,
  ...overrides,
});

/**
 * Fake PromptPort: `answers` scripts the confirms in order (a missing entry
 * means NO prompt is expected — an unscripted question throws), every
 * message is recorded.
 */
function fakeKillPrompts(answers: Array<boolean | 'cancel'>): {
  prompts: PromptPort;
  asked: string[];
  closedCount(): number;
} {
  const queue = [...answers];
  const asked: string[] = [];
  let closed = 0;
  const fail = (): never => {
    throw new Error('the orphan flow asks confirms only');
  };
  const prompts: PromptPort = {
    multiselect: fail,
    select: fail,
    text: fail,
    async confirm(question): Promise<PromptResult<boolean>> {
      asked.push(question.message);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unscripted confirm: ${question.message}`);
      }
      return next === 'cancel'
        ? { status: 'cancelled' }
        : { status: 'ok', value: next };
    },
    note: () => {},
    cancel: () => {},
    close: () => {
      closed += 1;
    },
  };
  return { prompts, asked, closedCount: () => closed };
}

interface OwnershipFakes {
  ownership: PortOwnership;
  probe: PortProbe;
  terminated: number[];
  ownerCalls: number[];
  busyProbes: number[];
}

/**
 * Fake OS side: canned owners per port; `terminate` records pids and returns
 * `terminateResult` (default true); `isPortBusy` answers busy for exactly
 * `busyPorts` MINUS the ports whose canned owner's pid was actually
 * terminated (unless `neverFree`) — a fake that freed on demand would hide a
 * missing kill.
 */
function fakeOs(options: {
  owners?: Record<number, PortOwnerInfo | null | 'throw'>;
  /** Ports the probe answers busy (until their owner's pid is terminated). */
  busyPorts?: number[];
  /** Port stays busy forever, even after its owner was terminated. */
  neverFree?: boolean;
  terminateResult?: boolean;
}): OwnershipFakes {
  const terminated: number[] = [];
  const ownerCalls: number[] = [];
  const busyProbes: number[] = [];
  const ownerOf = (port: number): PortOwnerInfo | null => {
    const answer = options.owners?.[port];
    return answer === undefined || answer === 'throw' ? null : answer;
  };
  return {
    terminated,
    ownerCalls,
    busyProbes,
    ownership: {
      async portOwner(port) {
        ownerCalls.push(port);
        const answer = options.owners?.[port];
        if (answer === 'throw') throw new Error('lsof failed');
        return answer ?? null;
      },
      terminate(pid) {
        terminated.push(pid);
        return options.terminateResult ?? true;
      },
    },
    probe: {
      async isPortBusy(port) {
        busyProbes.push(port);
        if (!(options.busyPorts ?? []).includes(port)) return false;
        if (options.neverFree === true) return true;
        const owner = ownerOf(port);
        return owner === null || !terminated.includes(owner.pid);
      },
      async findFreePort() {
        throw new Error('the orphan flow never allocates');
      },
    },
  };
}

/** Tiny bounds so a never-freeing port fails fast, not after 2s. */
const FAST = { waitFreeTimeoutMs: 60, pollMs: 10 };

function baseOptions(
  overrides: Partial<OrphanKillOptions> &
    Pick<OrphanKillOptions, 'ownership' | 'probe' | 'prompts'>
): OrphanKillOptions {
  return {
    busyPorts: [8081],
    appDirs: APP_DIRS,
    ...FAST,
    ...overrides,
  };
}

describe('isWorkspaceOrphan', () => {
  it('is true only for PPID 1 AND an app dir of THIS workspace in the argv', () => {
    assert.equal(isWorkspaceOrphan(orphan(4242), APP_DIRS), true);
  });
  it('is false for a reparented process from ANOTHER workspace', () => {
    assert.equal(
      isWorkspaceOrphan(
        orphan(4242, { command: 'node /other/apps/host/cli.js start' }),
        APP_DIRS
      ),
      false,
      'a foreign argv is not ours, whatever else matches'
    );
  });
  it('is false for a LIVE server of this workspace (ppid !== 1)', () => {
    assert.equal(
      isWorkspaceOrphan(orphan(4242, { ppid: 777 }), APP_DIRS),
      false,
      'a process with a living parent is not an orphan: never offer to kill it'
    );
  });
  it('is false with no app dirs at all', () => {
    assert.equal(isWorkspaceOrphan(orphan(4242), []), false);
  });
});

describe('killQuestion / describeKill', () => {
  it('the question carries the port, the honest claim, the pid and the command', () => {
    const question = killQuestion(8081, orphan(4242));
    assert.equal(
      question,
      'Port 8081 is held by an orphaned dev server of this workspace ' +
        '(pid 4242: node /ws/apps/host/node_modules/react-native/cli.js start --port 8081). Kill it?'
    );
  });
  it('the question applies the formatOwnerCommand cap', () => {
    const question = killQuestion(
      8081,
      orphan(4242, { command: 'z'.repeat(300) })
    );
    assert.match(question, /z{97}\.\.\.\)\. Kill it\?$/);
    assert.ok(question.length < 300, 'the capped line never grows with argv');
  });
  it('describeKill states the port and pid, nothing more than was done', () => {
    assert.equal(
      describeKill(8081, orphan(4242)),
      'killed orphaned dev server on port 8081 (pid 4242)'
    );
  });
});

describe('offerOrphanKills', () => {
  it('kills every confirmed workspace orphan and reports one note per port', async () => {
    const os = fakeOs({
      owners: { 8081: orphan(111), 9001: orphan(222, { command: 'node /ws/apps/alpha/cli.js start --port 9001' }) },
      busyPorts: [8081, 9001],
    });
    const prompts = fakeKillPrompts([true, true]);
    const outcome = await offerOrphanKills(
      baseOptions({
        busyPorts: [8081, 9001],
        ownership: os.ownership,
        probe: os.probe,
        prompts: prompts.prompts,
      })
    );
    assert.deepEqual(outcome, {
      status: 'killed',
      notes: [
        'killed orphaned dev server on port 8081 (pid 111)',
        'killed orphaned dev server on port 9001 (pid 222)',
      ],
    });
    assert.deepEqual(os.terminated, [111, 222], 'SIGTERM reached the right pids');
    assert.deepEqual(
      prompts.asked,
      [killQuestion(8081, orphan(111)), killQuestion(9001, orphan(222, { command: 'node /ws/apps/alpha/cli.js start --port 9001' }))],
      'one confirm per port, in busyPorts order'
    );
  });

  it('waits (bounded) for the port to free before calling it killed', async () => {
    // The port answers busy for the first two polls, then frees: proving the
    // poll loop actually polls (rather than trusting terminate's return).
    let polls = 0;
    const os = fakeOs({ owners: { 8081: orphan(111) }, busyPorts: [8081] });
    const freeingProbe: PortProbe = {
      async isPortBusy() {
        polls += 1;
        return polls < 3;
      },
      async findFreePort() {
        throw new Error('unused');
      },
    };
    const prompts = fakeKillPrompts([true]);
    const outcome = await offerOrphanKills(
      baseOptions({
        ownership: os.ownership,
        probe: freeingProbe,
        prompts: prompts.prompts,
      })
    );
    assert.equal(outcome.status, 'killed');
    assert.ok(polls >= 3, `polled until free (polled ${polls}x)`);
  });

  for (const [label, setup] of [
    ['the owner is unknown (portOwner null)', { owners: { 8081: null } }],
    ['the owner lookup throws', { owners: { 8081: 'throw' as const } }],
    [
      'the owner is live (ppid !== 1)',
      { owners: { 8081: orphan(111, { ppid: 777 }) } },
    ],
    [
      'the owner is from another workspace',
      { owners: { 8081: orphan(111, { command: 'node /elsewhere/cli.js start' }) } },
    ],
  ] as const) {
    it(`${label}: unavailable, and NO prompt is shown`, async () => {
      const os = fakeOs({ ...setup, busyPorts: [8081] });
      const prompts = fakeKillPrompts([]); // any question would throw
      const outcome = await offerOrphanKills(
        baseOptions({
          ownership: os.ownership,
          probe: os.probe,
          prompts: prompts.prompts,
        })
      );
      assert.deepEqual(outcome, { status: 'unavailable' });
      assert.deepEqual(prompts.asked, []);
      assert.deepEqual(os.terminated, []);
    });
  }

  it('one non-orphan among several orphans kills NOTHING (all-or-nothing offer)', async () => {
    const os = fakeOs({
      owners: {
        8081: orphan(111),
        8082: orphan(222, { ppid: 42 }), // live sibling -> no offer at all
      },
      busyPorts: [8081, 8082],
    });
    const prompts = fakeKillPrompts([]);
    const outcome = await offerOrphanKills(
      baseOptions({
        busyPorts: [8081, 8082],
        ownership: os.ownership,
        probe: os.probe,
        prompts: prompts.prompts,
      })
    );
    assert.deepEqual(outcome, { status: 'unavailable' });
    assert.deepEqual(prompts.asked, []);
    assert.deepEqual(os.terminated, []);
  });

  it('a declined confirm stops the flow: that pid is never terminated', async () => {
    const os = fakeOs({
      owners: { 8081: orphan(111), 9001: orphan(222) },
      busyPorts: [8081, 9001],
    });
    const prompts = fakeKillPrompts([true, false]);
    const outcome = await offerOrphanKills(
      baseOptions({
        busyPorts: [8081, 9001],
        ownership: os.ownership,
        probe: os.probe,
        prompts: prompts.prompts,
      })
    );
    assert.deepEqual(outcome, { status: 'declined' });
    assert.deepEqual(os.terminated, [111], 'only the FIRST confirmed pid was killed');
  });

  it('a cancelled confirm is a decline too', async () => {
    const os = fakeOs({ owners: { 8081: orphan(111) }, busyPorts: [8081] });
    const prompts = fakeKillPrompts(['cancel']);
    const outcome = await offerOrphanKills(
      baseOptions({
        ownership: os.ownership,
        probe: os.probe,
        prompts: prompts.prompts,
      })
    );
    assert.deepEqual(outcome, { status: 'declined' });
    assert.deepEqual(os.terminated, []);
  });

  it('terminate answering false (already gone / not ours) lands on unavailable', async () => {
    const os = fakeOs({
      owners: { 8081: orphan(111) },
      busyPorts: [8081],
      terminateResult: false,
    });
    const prompts = fakeKillPrompts([true]);
    const outcome = await offerOrphanKills(
      baseOptions({
        ownership: os.ownership,
        probe: os.probe,
        prompts: prompts.prompts,
      })
    );
    assert.deepEqual(outcome, { status: 'unavailable' });
  });

  it('a port that stays busy past waitFreeTimeoutMs lands on unavailable', async () => {
    // neverFree keeps the probe busy even after the terminate; the tiny
    // waitFreeTimeoutMs/pollMs overrides keep the test fast.
    const os = fakeOs({
      owners: { 8081: orphan(111) },
      busyPorts: [8081],
      neverFree: true,
    });
    const prompts = fakeKillPrompts([true]);
    const started = Date.now();
    const outcome = await offerOrphanKills(
      baseOptions({
        ownership: os.ownership,
        probe: os.probe,
        prompts: prompts.prompts,
      })
    );
    assert.deepEqual(outcome, { status: 'unavailable' });
    assert.ok(
      Date.now() - started < 5_000,
      'the bounded wait is bounded by waitFreeTimeoutMs, not the 2s default'
    );
  });

  it('no busy ports means nothing to offer (never an empty confirm loop)', async () => {
    const os = fakeOs({});
    const prompts = fakeKillPrompts([]);
    const outcome = await offerOrphanKills(
      baseOptions({
        busyPorts: [],
        ownership: os.ownership,
        probe: os.probe,
        prompts: prompts.prompts,
      })
    );
    assert.deepEqual(outcome, { status: 'unavailable' });
    assert.deepEqual(os.ownerCalls, [], 'not even an owner lookup runs');
  });
});
