// Pure unit tests for the port allocator: fake probes, no sockets.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DevPlanEntry } from '../../src/runner/plan.js';
import {
  allocatePorts,
  applyAssignments,
  describeReassignments,
  formatOwnerCommand,
  type PortProbe,
} from '../../src/runner/ports.js';

function entry(key: string, declaredPort: number | null): DevPlanEntry {
  return {
    key,
    name: key,
    role: key === 'host' ? 'host' : 'remote',
    launch: { kind: 'command', command: 'true' },
    cwd: '/ws',
    declaredPort,
  };
}

/** Fake probe: `busy` ports answer; free ports are handed out from `free`. */
function probe(busy: number[], free: number[] = [50_001, 50_002, 50_003]) {
  const queue = [...free];
  const asked: number[] = [];
  const fake: PortProbe = {
    async isPortBusy(port) {
      asked.push(port);
      return busy.includes(port);
    },
    async findFreePort() {
      const next = queue.shift();
      assert.ok(next !== undefined, 'fake probe ran out of free ports');
      return next;
    },
  };
  return { fake, asked };
}

const ENTRIES = [entry('host', 8081), entry('a', 8082), entry('b', null)];

describe('allocatePorts', () => {
  it('keeps free declared ports and gives auto apps a free port', async () => {
    const { fake } = probe([]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.deepEqual(result, {
      ok: true,
      assignments: [
        { key: 'host', port: 8081, source: 'declared' },
        { key: 'a', port: 8082, source: 'declared' },
        { key: 'b', port: 50_001, source: 'auto' },
      ],
    });
  });

  it('collects ALL conflicts in plan order, not just the first', async () => {
    const { fake, asked } = probe([8081, 8082]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.deepEqual(result, {
      ok: false,
      conflicts: [
        'port 8081 declared by host is already busy',
        'port 8082 declared by a is already busy',
      ],
      // Additive (ODD dev-port-conflict-warn-kill): the busy declared ports,
      // in plan order — the input the human-path orphan flow acts on.
      busyPorts: [8081, 8082],
    });
    assert.deepEqual(asked, [8081, 8082], 'every declared port was probed');
  });

  it('--auto-ports reassigns busy ports and records the original', async () => {
    const { fake } = probe([8081]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: true,
      resolveAuto: true,
    });
    assert.ok(result.ok);
    assert.deepEqual(result.assignments, [
      { key: 'host', port: 50_001, source: 'reassigned', requested: 8081 },
      { key: 'a', port: 8082, source: 'declared' },
      { key: 'b', port: 50_002, source: 'auto' },
    ]);
    assert.deepEqual(describeReassignments(result.assignments), [
      'port 8081 for host was busy — using 50001 (--auto-ports)',
    ]);
  });

  it('a "free" port that is another app\'s declared port is skipped', async () => {
    const { fake } = probe([8081], [8082, 50_001, 50_002]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: true,
      resolveAuto: true,
    });
    assert.ok(result.ok);
    assert.equal(result.assignments[0]!.port, 50_001);
  });

  it('dry-run mode (resolveAuto: false) leaves unmanaged remotes null', async () => {
    const { fake } = probe([]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: false,
      resolveAuto: false,
    });
    assert.ok(result.ok);
    assert.equal(result.assignments[2]!.port, null);
  });

  it('applyAssignments writes allocated ports back onto the entries', async () => {
    const { fake } = probe([8081]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: true,
      resolveAuto: false,
    });
    assert.ok(result.ok);
    const applied = applyAssignments(ENTRIES, result.assignments);
    assert.deepEqual(
      applied.map((e) => e.allocatedPort ?? null),
      [50_001, 8082, null]
    );
    assert.deepEqual(
      applied.map((e) => e.declaredPort),
      ENTRIES.map((e) => e.declaredPort),
      'allocation never rewrites what the plan declared'
    );
  });

  it('never throws when no free port exists: it reports a conflict', async () => {
    const exhausted: PortProbe = {
      async isPortBusy(port) {
        return port === 8081;
      },
      // Always answers a port already promised to another app.
      async findFreePort() {
        return 8082;
      },
    };
    const reassign = await allocatePorts(ENTRIES, exhausted, {
      autoPorts: true,
      resolveAuto: true,
    });
    assert.ok(!reassign.ok);
    assert.match(reassign.conflicts.join('\n'), /host is busy and no free port/);
    assert.match(reassign.conflicts.join('\n'), /no free port available for/);

    const failing: PortProbe = {
      async isPortBusy() {
        return false;
      },
      async findFreePort() {
        throw new Error('EMFILE');
      },
    };
    const auto = await allocatePorts(ENTRIES, failing, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.ok(!auto.ok);
    assert.match(auto.conflicts[0]!, /no free port available for/);
  });
});

// ODD dev-port-conflict-warn-kill: busyPorts is the additive field the
// human-path orphan flow keys on, so its shape contract needs its own tests.
describe('allocatePorts busyPorts (orphan-flow input)', () => {
  it('is ABSENT when a conflict is not caused by a busy declared port', async () => {
    // Duplicate-declared ports only: nothing was found busy, so the orphan
    // flow must see no busyPorts at all (the caller gates on them).
    const dup = [entry('host', 8082), entry('a', 8082)];
    const { fake } = probe([]);
    const result = await allocatePorts(dup, fake, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.ok(!result.ok);
    assert.equal('busyPorts' in result, false, 'no busy port, no busyPorts key');
  });

  it('is ABSENT from an ok allocation', async () => {
    const { fake } = probe([]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.ok(result.ok);
    assert.equal('busyPorts' in result, false);
  });

  it('lists a port a throwing probe could not vouch for (busy is the honest answer)', async () => {
    const throwing: PortProbe = {
      async isPortBusy() {
        throw new Error('probe exploded');
      },
      async findFreePort() {
        return 50_001;
      },
    };
    const result = await allocatePorts([entry('host', 8081)], throwing, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.ok(!result.ok);
    assert.deepEqual(result.busyPorts, [8081]);
  });

  it('is absent under --auto-ports (a reassignment is not a conflict)', async () => {
    const { fake } = probe([8081]);
    const result = await allocatePorts(ENTRIES, fake, {
      autoPorts: true,
      resolveAuto: true,
    });
    assert.ok(result.ok);
  });
});

describe('formatOwnerCommand', () => {
  it('collapses runs of whitespace and trims', () => {
    assert.equal(
      formatOwnerCommand('  node   /ws/apps/host/cli.js   start  '),
      'node /ws/apps/host/cli.js start'
    );
  });
  it('leaves a command within the cap untouched', () => {
    const command = 'node cli.js start --port 8081';
    assert.equal(formatOwnerCommand(command), command);
  });
  it('caps at maxLength with a trailing ellipsis inside the cap', () => {
    const long = 'x'.repeat(250);
    const formatted = formatOwnerCommand(long);
    assert.equal(formatted.length, 100, 'the cap is the CONTRACT of a question line');
    assert.ok(formatted.endsWith('...'));
    assert.equal(formatted, `${'x'.repeat(97)}...`);
  });
  it('honours a custom cap', () => {
    const formatted = formatOwnerCommand('abcdefghij', 7);
    assert.equal(formatted, 'abcd...');
  });
});

describe('duplicate declared ports', () => {
  const dup = [entry('host', 8081), entry('a', 8082), entry('b', 8082)];

  it('two apps declaring the same free port are a conflict naming both', async () => {
    const { fake } = probe([]);
    const result = await allocatePorts(dup, fake, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.deepEqual(result, {
      ok: false,
      conflicts: ['port 8082 is declared by both a and b'],
    });
  });

  it('is reported together with busy-port conflicts', async () => {
    const { fake } = probe([8081]);
    const result = await allocatePorts(dup, fake, {
      autoPorts: false,
      resolveAuto: false,
    });
    assert.deepEqual(result, {
      ok: false,
      conflicts: [
        'port 8081 declared by host is already busy',
        'port 8082 is declared by both a and b',
      ],
      // Only the BUSY declared port is a kill candidate; the duplicate-declared
      // conflict is not a busy port, so it stays out of busyPorts.
      busyPorts: [8081],
    });
  });

  it('--auto-ports keeps the first declarer and moves the later one', async () => {
    const { fake } = probe([]);
    const result = await allocatePorts(dup, fake, {
      autoPorts: true,
      resolveAuto: true,
    });
    assert.deepEqual(result, {
      ok: true,
      assignments: [
        { key: 'host', port: 8081, source: 'declared' },
        { key: 'a', port: 8082, source: 'declared' },
        { key: 'b', port: 50_001, source: 'reassigned', requested: 8082 },
      ],
    });
  });

  it('applyAssignments records reassignedFrom for --json', () => {
    const applied = applyAssignments(dup, [
      { key: 'host', port: 8081, source: 'declared' },
      { key: 'a', port: 8082, source: 'declared' },
      { key: 'b', port: 50_001, source: 'reassigned', requested: 8082 },
    ]);
    assert.deepEqual(
      applied.map((e) => e.reassignedFrom),
      [undefined, undefined, 8082]
    );
  });
});

describe('allocatePorts with a throwing probe', () => {
  it('treats a probe that throws as busy: a conflict, never a crash', async () => {
    const throwing: PortProbe = {
      async isPortBusy() {
        throw new Error('probe exploded');
      },
      async findFreePort() {
        return 50_001;
      },
    };
    const result = await allocatePorts([entry('host', 8081)], throwing, {
      autoPorts: false,
      resolveAuto: true,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.conflicts.join('\n'), /port 8081 declared by host is already busy/);
  });

  it('--auto-ports moves it to a free port instead', async () => {
    const throwing: PortProbe = {
      async isPortBusy() {
        throw new Error('probe exploded');
      },
      async findFreePort() {
        return 50_001;
      },
    };
    const result = await allocatePorts([entry('host', 8081)], throwing, {
      autoPorts: true,
      resolveAuto: true,
    });
    assert.ok(result.ok);
    assert.equal(result.assignments[0]!.port, 50_001);
  });
});
