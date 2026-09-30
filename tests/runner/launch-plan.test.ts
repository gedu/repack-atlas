// Pure unit tests for the launch plan (no spawn, no fs, no sockets).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReactNativeCliResult } from '../../src/core/index.js';
import {
  buildLaunchPlan,
  formatLaunchLine,
  toPlanEventLaunch,
} from '../../src/runner/launch-plan.js';
import type { DevPlanEntry } from '../../src/runner/plan.js';
import {
  resolveToolchains,
} from '../../src/runner/toolchain.js';

function entry(
  key: string,
  extra: Partial<DevPlanEntry> = {}
): DevPlanEntry {
  return {
    key,
    name: key === 'host' ? 'host_app' : key,
    role: key === 'host' ? 'host' : 'remote',
    launch: { kind: 'command', command: 'true' },
    cwd: '/ws',
    declaredPort: null,
    root: `/ws/apps/${key}`,
    ...extra,
  };
}

const okCli = (root: string): ReactNativeCliResult => ({
  status: 'ok',
  cli: `${root}/node_modules/react-native/cli.js`,
});

function build(
  entries: DevPlanEntry[],
  extra: { device?: string; resolveCli?: (root: string) => ReactNativeCliResult } = {}
) {
  return buildLaunchPlan({
    entries,
    platform: 'ios',
    resolveCli: extra.resolveCli ?? okCli,
    ...(extra.device !== undefined ? { device: extra.device } : {}),
  });
}

describe('buildLaunchPlan', () => {
  it('targets the host: its own cli, run-<platform> --no-packager, cwd = root', () => {
    const result = build([entry('host'), entry('a')]);
    assert.ok(result.ok);
    assert.deepEqual(result.launch, {
      triggerKey: 'host',
      app: 'host_app',
      file: process.execPath,
      args: [
        '/ws/apps/host/node_modules/react-native/cli.js',
        'run-ios',
        '--no-packager',
      ],
      cwd: '/ws/apps/host',
    });
  });

  it('prefers the standalone remote over the host', () => {
    const result = build([
      entry('host'),
      entry('solo', { standalone: true }),
    ]);
    assert.ok(result.ok);
    assert.equal(result.launch.triggerKey, 'solo');
    assert.equal(result.launch.cwd, '/ws/apps/solo');
    assert.equal(result.launch.args[0], '/ws/apps/solo/node_modules/react-native/cli.js');
  });

  it('passes --device verbatim as one argv entry', () => {
    const result = build([entry('host')], { device: 'iPhone 15 Pro; rm -rf /' });
    assert.ok(result.ok);
    assert.deepEqual(result.launch.args.slice(-2), [
      '--device',
      'iPhone 15 Pro; rm -rf /',
    ]);
  });

  it('uses the platform in the subcommand', () => {
    const result = buildLaunchPlan({
      entries: [entry('host')],
      platform: 'android',
      resolveCli: okCli,
    });
    assert.ok(result.ok);
    assert.equal(result.launch.args[1], 'run-android');
  });

  it('a `command` target still resolves its cli from the root', () => {
    const seen: string[] = [];
    const result = build(
      [entry('host', { launch: { kind: 'command', command: 'pnpm start' } })],
      {
        resolveCli: (root) => {
          seen.push(root);
          return okCli(root);
        },
      }
    );
    assert.ok(result.ok);
    assert.deepEqual(seen, ['/ws/apps/host']);
  });

  it('fails when neither the host nor a standalone remote is in the session', () => {
    const result = build([entry('a'), entry('b')]);
    assert.ok(!result.ok);
    assert.match(result.reason, /needs the host \(or the --standalone remote\)/);
  });

  it('fails when the target declares no root', () => {
    const { root: _root, ...rootless } = entry('host');
    const result = build([rootless as DevPlanEntry]);
    assert.ok(!result.ok);
    assert.match(result.reason, /host declares no "root"/);
    assert.match(result.reason, /run-ios/);
  });

  it('fails naming the target when its cli cannot be resolved', () => {
    const result = build([entry('host')], {
      resolveCli: () => ({ status: 'failed', message: 'no react-native here' }),
    });
    assert.ok(!result.ok);
    assert.match(result.reason, /host: no react-native here \(app root \/ws\/apps\/host\)/);
  });
});

describe('launch display', () => {
  const planned = () => {
    const result = build([entry('host')], { device: 'emulator-5554' });
    assert.ok(result.ok);
    return result.launch;
  };

  it('shows `node <cli relative to cwd> run-... ` without the node path', () => {
    assert.deepEqual(toPlanEventLaunch(planned()), {
      app: 'host_app',
      command:
        'node node_modules/react-native/cli.js run-ios --no-packager --device emulator-5554',
      cwd: '/ws/apps/host',
    });
  });

  it('formats one human line', () => {
    assert.equal(
      formatLaunchLine(planned()),
      'launch (once host_app is ready): node node_modules/react-native/cli.js run-ios --no-packager --device emulator-5554  [cwd /ws/apps/host]'
    );
  });
});

describe('resolveToolchains (injected resolver edge cases)', () => {
  it('a resolver that throws fails that app only, not the plan', async () => {
    const toolchains = await resolveToolchains(
      [{ root: '/ws/a' }, { root: '/ws/b' }],
      {
        fs: {
          readdir: async () => [],
        } as never,
        reactNativeCli: {
          resolve(root) {
            if (root === '/ws/a') throw new Error('boom');
            return okCli(root);
          },
        },
      }
    );
    const a = toolchains['/ws/a']!;
    assert.ok(!a.ok);
    assert.match(a.reason, /lookup failed: Error: boom/);
    assert.ok(toolchains['/ws/b']!.ok);
  });
});
