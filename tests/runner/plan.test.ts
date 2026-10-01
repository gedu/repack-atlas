// Pure unit tests for `buildDevPlan` (no spawn, no fs, no sockets).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FederationConfig } from '../../src/core/index.js';
import { toolchainKey, type Toolchains } from '../../src/runner/toolchain.js';
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

  it('skips apps with neither command nor root and reports them', () => {
    const plan = ok(build());
    assert.deepEqual(
      plan.skipped.map((s) => [s.key, s.name]),
      [['idle', 'idle']]
    );
    assert.match(plan.skipped[0]!.reason, /no "command" or "root"/);
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

describe('default argv (root without command)', () => {
  const HOST_ROOT = '/ws/apps/host';
  const toolchains: Toolchains = {
    [HOST_ROOT]: { ok: true, bundler: 'rspack', cli: `${HOST_ROOT}/node_modules/react-native/cli.js` },
    [toolchainKey('/ws/apps/web', 'webpack.dev.js')]: { ok: true, bundler: 'webpack', cli: '/store/rn/cli.js' },
  };
  const config: FederationConfig = {
    host: { manifest: './m/host.json', root: './apps/host' },
    remotes: {
      web: {
        manifest: './m/web.json',
        root: './apps/web',
        config: 'webpack.dev.js',
        port: 9001,
      },
      legacy: {
        manifest: './m/legacy.json',
        root: './apps/legacy',
        command: 'run legacy',
      },
    },
  };
  const plan = (extra: Partial<Parameters<typeof buildDevPlan>[0]> = {}) =>
    buildDevPlan({
      config,
      configDir: CONFIG_DIR,
      hostName: 'host_app',
      toolchains,
      ...extra,
    });

  it('runs a root-only app as an argv launch with cwd = its root', () => {
    const [host, web, legacy] = ok(plan()).entries;
    assert.deepEqual(host!.launch, {
      kind: 'argv',
      file: process.execPath,
      cli: `${HOST_ROOT}/node_modules/react-native/cli.js`,
      bundler: 'rspack',
    });
    assert.equal(host!.cwd, HOST_ROOT);
    assert.equal(web!.cwd, '/ws/apps/web');
    assert.deepEqual(web!.launch, {
      kind: 'argv',
      file: process.execPath,
      cli: '/store/rn/cli.js',
      bundler: 'webpack',
      config: '/ws/webpack.dev.js',
    });
    // `command` stays an override: verbatim, config-dir cwd, no toolchain.
    assert.deepEqual(legacy!.launch, { kind: 'command', command: 'run legacy' });
    assert.equal(legacy!.cwd, CONFIG_DIR);
  });

  it('projects the effective command line (no node path, cli relative to cwd)', () => {
    const apps = toPlanEventApps(ok(plan()).entries);
    assert.equal(
      apps[0]!.command,
      'node node_modules/react-native/cli.js start --bundler rspack --port 8081 --no-interactive'
    );
    assert.match(apps[1]!.command, /^node \/store\/rn\/cli\.js start --bundler webpack --config \/ws\/webpack\.dev\.js --port 9001 /);
    assert.equal(apps[2]!.command, 'run legacy');
    assert.equal(apps[0]!.cwd, HOST_ROOT);
  });

  it('forwards platform to built argvs and --standalone to the one remote', () => {
    const standaloneConfig: FederationConfig = {
      ...config,
      remotes: {
        ...config.remotes,
        web: { ...config.remotes.web!, standalone: true },
      },
    };
    const entries = ok(
      plan({ config: standaloneConfig, platform: 'ios', standalone: 'web' })
    ).entries;
    const line = (i: number) => toPlanEventApps(entries)[i]!.command;
    assert.match(line(0), /--platform ios$/);
    assert.match(line(1), /--platform ios --standalone$/);
    // A command is never rewritten: it sees platform/standalone as env only.
    assert.equal(line(2), 'run legacy');
    assert.deepEqual(
      entries.map((e) => [e.platform, e.standalone]),
      [
        ['ios', undefined],
        ['ios', true],
        ['ios', undefined],
      ]
    );
  });

  it('two apps sharing a root keep their own bundler (no toolchain key collision)', () => {
    const shared: FederationConfig = {
      host: { manifest: './m/h.json', root: './apps/shared', config: 'rspack.a.js' },
      remotes: {
        r: { manifest: './m/r.json', root: './apps/shared', config: 'webpack.b.js' },
      },
    };
    const result = ok(
      buildDevPlan({
        config: shared,
        configDir: CONFIG_DIR,
        hostName: 'h',
        toolchains: {
          [toolchainKey('/ws/apps/shared', 'rspack.a.js')]: { ok: true, bundler: 'rspack', cli: '/c.js' },
          [toolchainKey('/ws/apps/shared', 'webpack.b.js')]: { ok: true, bundler: 'webpack', cli: '/c.js' },
        },
      })
    );
    assert.deepEqual(
      result.entries.map((e) => e.launch.kind === 'argv' && e.launch.bundler),
      ['rspack', 'webpack']
    );
  });

  it('an unresolvable toolchain fails the plan naming every such app', () => {
    const result = plan({
      toolchains: {
        [HOST_ROOT]: { ok: false, reason: 'cannot resolve the "react-native" package' },
      },
    });
    assert.ok(!result.ok);
    assert.equal(result.reasons.length, 2);
    assert.match(result.reasons[0]!, /^host: cannot resolve the "react-native" package \(app root \/ws\/apps\/host\)$/);
    assert.match(result.reasons[1]!, /^web: toolchain was not resolved/);
  });

  it('does not need a toolchain for apps with a command', () => {
    const result = plan({ toolchains: {}, apps: ['legacy'] });
    assert.ok(result.ok);
  });

  it('an unresolved manifest URL never becomes a manifestPath', () => {
    const url = buildDevPlan({
      config: {
        host: { manifest: 'https://cdn.example/h.json', command: 'x' },
        remotes: {},
      },
      configDir: CONFIG_DIR,
      hostName: 'h',
    });
    assert.equal(ok(url).entries[0]!.manifestPath, undefined);
  });
});

describe('--platform / --standalone in the plan', () => {
  const config: FederationConfig = {
    host: { manifest: './m/host.json', command: 'run host' },
    remotes: {
      solo: { manifest: './m/solo.json', standalone: true, command: 'run solo' },
      plain: { manifest: './m/plain.json', command: 'run plain' },
      declined: { manifest: './m/d.json', standalone: false, command: 'run d' },
      rootless: { manifest: './m/r.json', standalone: true },
    },
  };
  const plan = (extra: Partial<Parameters<typeof buildDevPlan>[0]> = {}) =>
    buildDevPlan({ config, configDir: CONFIG_DIR, hostName: 'h', ...extra });

  it('an unknown --standalone remote fails the plan listing known remotes', () => {
    const result = plan({ standalone: 'nope' });
    assert.ok(!result.ok);
    assert.match(result.reasons[0]!, /unknown remote: nope \(known remotes: solo, plain, declined, rootless\)/);
  });

  it('refuses a remote without standalone: true (absent or false), naming the file', () => {
    for (const name of ['plain', 'declined']) {
      const result = plan({ standalone: name });
      assert.ok(!result.ok);
      assert.equal(
        result.reasons[0],
        `--standalone refused: remote "${name}" does not declare standalone support. Set "standalone": true for it in /ws/repack-federation.json.`
      );
    }
  });

  it('refuses a standalone remote that cannot run (no command, no root)', () => {
    const result = plan({ standalone: 'rootless' });
    assert.ok(!result.ok);
    assert.match(result.reasons[0]!, /rootless: the remote declares neither/);
  });

  it('adds the standalone remote to a session that --apps omitted it from', () => {
    const entries = ok(plan({ apps: ['host'], standalone: 'solo' })).entries;
    assert.deepEqual(
      entries.map((e) => [e.key, e.standalone]),
      [
        ['host', undefined],
        ['solo', true],
      ]
    );
  });

  it('omits platform/standalone when not requested', () => {
    const [host] = ok(plan({ apps: ['host'] })).entries;
    assert.equal('platform' in host!, false);
    assert.equal('standalone' in host!, false);
    assert.equal('platform' in toPlanEventApps([host!])[0]!, false);
  });

  it('projects platform and standalone (additive) and shows them in the table', () => {
    const entries = ok(plan({ apps: ['host', 'solo'], platform: 'android', standalone: 'solo' })).entries;
    const apps = toPlanEventApps(entries);
    assert.deepEqual(
      apps.map((a) => [a.platform, a.standalone]),
      [
        ['android', undefined],
        ['android', true],
      ]
    );
    const table = formatPlanTable(entries);
    assert.match(table, /^app\s+role\s+port\s+platform\s+command\s+cwd$/m);
    assert.match(table, /^solo\s+remote \(standalone\)\s+auto\s+android\s+run solo/m);
  });
});

describe('buildDevPlan port overrides (wizard answers)', () => {
  const ports = (overrides: Record<string, number>, hostPort?: number) => {
    const result = ok(
      buildDevPlan({
        config: CONFIG,
        configDir: CONFIG_DIR,
        hostName: 'host_app',
        ports: overrides,
        ...(hostPort !== undefined ? { hostPort } : {}),
      })
    );
    return Object.fromEntries(
      result.entries.map((entry) => [entry.key, entry.declaredPort])
    );
  };

  it('beats the declared port, --port and the 8081 default; auto stays auto', () => {
    assert.deepEqual(ports({ host: 9000, zeta: 9100 }, 8500), {
      host: 9000,
      zeta: 9100,
      alpha: null,
    });
    assert.deepEqual(ports({}, 8500), { host: 8500, zeta: 9001, alpha: null });
  });

  it('gives an auto remote the port the user named', () => {
    assert.equal(ports({ alpha: 9200 }).alpha, 9200);
  });
});
