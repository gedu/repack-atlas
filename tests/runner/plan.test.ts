// Pure unit tests for `buildDevPlan` (no spawn, no fs, no sockets).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FederationConfig } from '../../src/core/index.js';
import {
  buildDevPlan,
  HOST_DEFAULT_PORT,
  formatPlanTable,
  toPlanEventApps,
  type BuildDevPlanResult,
} from '../../src/runner/plan.js';

const CONFIG_DIR = '/ws';

const CONFIG: FederationConfig = {
  host: { manifest: './m/host.json', root: './apps/host', command: 'run host' },
  remotes: {
    zeta: { manifest: './m/zeta.json', port: 9001, command: 'run zeta' },
    alpha: { manifest: 'https://cdn.example/alpha.json', command: 'run alpha' },
    idle: { manifest: './m/idle.json' },
  },
};

function build(apps?: string[], config = CONFIG): BuildDevPlanResult {
  return buildDevPlan({
    config,
    configDir: CONFIG_DIR,
    hostName: 'host_app',
    ...(apps !== undefined ? { apps } : {}),
  });
}

function ok(result: BuildDevPlanResult) {
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

describe('buildDevPlan', () => {
  it('orders host first, then remotes in declaration order', () => {
    const plan = ok(build());
    assert.deepEqual(
      plan.entries.map((e) => [e.key, e.name, e.role]),
      [
        ['host', 'host_app', 'host'],
        ['zeta', 'zeta', 'remote'],
        ['alpha', 'alpha', 'remote'],
      ]
    );
  });

  it('carries declared port (null = auto), cwd, root and manifest', () => {
    const [host, zeta, alpha] = ok(build()).entries;
    assert.equal(host!.declaredPort, 8081, 'host defaults to 8081');
    assert.equal(alpha!.declaredPort, null, 'remotes default to auto');
    assert.equal(zeta!.declaredPort, 9001);
    assert.equal(host!.cwd, CONFIG_DIR);
    assert.equal(host!.root, '/ws/apps/host');
    assert.equal(host!.manifestPath, '/ws/m/host.json');
    assert.equal(alpha!.manifestPath, undefined, 'URL manifests have no path');
    assert.equal(alpha!.root, undefined);
  });

  it('skips apps without a command and reports them', () => {
    const plan = ok(build());
    assert.deepEqual(
      plan.skipped.map((s) => [s.key, s.name]),
      [['idle', 'idle']]
    );
    assert.match(plan.skipped[0]!.reason, /no "command"/);
  });

  it('--apps filters while keeping plan order', () => {
    const plan = ok(build(['alpha', 'host']));
    assert.deepEqual(
      plan.entries.map((e) => e.key),
      ['host', 'alpha']
    );
    assert.deepEqual(ok(build(['idle'])).skipped.map((s) => s.key), ['idle']);
  });

  it('unknown --apps fails naming the unknown and the known keys', () => {
    const result = build(['host', 'nope']);
    assert.ok(!result.ok);
    assert.match(result.reasons[0]!, /unknown apps: nope/);
    assert.match(result.reasons[0]!, /known: alpha, host, idle, zeta/);
  });

  it('rejects an out-of-range declared port', () => {
    const result = build(undefined, {
      ...CONFIG,
      remotes: { bad: { manifest: './b.json', port: 70_000, command: 'x' } },
    });
    assert.ok(!result.ok);
    assert.match(result.reasons[0]!, /bad\.port must be a TCP port/);
  });

  it('is deterministic: same input, deep-equal output', () => {
    assert.deepEqual(build(), build());
  });

  it('projects to the event shape and a table (8081 host default, `auto` remote)', () => {
    const { entries } = ok(build());
    assert.deepEqual(toPlanEventApps(entries)[1], {
      app: 'zeta',
      role: 'remote',
      port: 9001,
      command: 'run zeta',
      cwd: CONFIG_DIR,
    });
    const lines = formatPlanTable(entries).split('\n');
    assert.match(lines[0]!, /^app\s+role\s+port\s+command\s+cwd$/);
    assert.match(lines[1]!, /^host_app\s+host\s+8081\s+run host\s+\/ws$/);
    assert.match(lines[3]!, /^alpha\s+remote\s+auto\s+run alpha\s+\/ws$/);
    assert.match(lines[2]!, /^zeta\s+remote\s+9001\s+run zeta\s+\/ws$/);
  });
});

describe('host port precedence', () => {
  const hostPortOf = (config: FederationConfig, hostPort?: number): number | null => {
    const result = ok(
      buildDevPlan({
        config,
        configDir: CONFIG_DIR,
        hostName: 'host_app',
        ...(hostPort !== undefined ? { hostPort } : {}),
      })
    );
    return result.entries[0]!.declaredPort;
  };
  const withHostPort = (port?: number): FederationConfig => ({
    ...CONFIG,
    host: { ...CONFIG.host, ...(port !== undefined ? { port } : {}) },
  });

  it('--port > config host port > 8081', () => {
    assert.equal(HOST_DEFAULT_PORT, 8081);
    assert.equal(hostPortOf(withHostPort(), undefined), 8081);
    assert.equal(hostPortOf(withHostPort(9100), undefined), 9100);
    assert.equal(hostPortOf(withHostPort(9100), 9200), 9200);
    assert.equal(hostPortOf(withHostPort(), 9200), 9200);
  });

  it('--port touches the host only; remotes keep declared port or auto', () => {
    const plan = ok(
      buildDevPlan({
        config: CONFIG,
        configDir: CONFIG_DIR,
        hostName: 'host_app',
        hostPort: 9200,
      })
    );
    assert.deepEqual(
      plan.entries.map((e) => e.declaredPort),
      [9200, 9001, null]
    );
  });
});
