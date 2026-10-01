// Pure unit tests for the default-argv rules: bundler detection, argv
// building and the readable command line. No fs, no spawn.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cliInvocation,
  describeLaunch,
  detectBundler,
  startArgs,
  type DevLaunch,
} from '../../src/runner/start-argv.js';

type ArgvLaunch = Extract<DevLaunch, { kind: 'argv' }>;

/** `start` options of a callstack/repack PR #1467 build. */
const PR1467 = [
  '--bundler',
  '--config',
  '--port',
  '--no-interactive',
  '--platform',
  '--standalone',
];
/** `start` options of published Re.Pack 5.x (no --bundler/--standalone). */
const REPACK5 = PR1467.filter(
  (flag) => flag !== '--bundler' && flag !== '--standalone'
);

const launch = (extra: Partial<ArgvLaunch> = {}): ArgvLaunch => ({
  kind: 'argv',
  file: '/usr/bin/node',
  cli: '/ws/apps/host/node_modules/react-native/cli.js',
  bundler: 'rspack',
  startOptions: PR1467,
  ...extra,
});

describe('detectBundler (upstream precedence)', () => {
  it('a declared config name wins over the files present', () => {
    assert.equal(
      detectBundler({
        files: ['rspack.config.js'],
        config: 'configs/webpack.custom.js',
      }),
      'webpack'
    );
    assert.equal(
      detectBundler({ files: ['webpack.config.js'], config: 'rspack.dev.mjs' }),
      'rspack'
    );
  });

  it('a config named neither way falls through to the files present', () => {
    assert.equal(
      detectBundler({ files: ['webpack.config.js'], config: 'x.js' }),
      'webpack'
    );
    assert.equal(detectBundler({ files: [], config: 'x.js' }), 'rspack');
  });

  it('infers from the config files in the app root', () => {
    assert.equal(detectBundler({ files: ['rspack.config.ts', 'a.ts'] }), 'rspack');
    assert.equal(detectBundler({ files: ['webpack.config.cjs'] }), 'webpack');
    assert.equal(detectBundler({ files: ['.webpack/webpackfile'] }), 'webpack');
  });

  it('both present or none found falls back to rspack', () => {
    assert.equal(
      detectBundler({ files: ['rspack.config.js', 'webpack.config.js'] }),
      'rspack'
    );
    assert.equal(detectBundler({ files: ['package.json'] }), 'rspack');
  });
});

describe('startArgs', () => {
  it('builds the pinned argv: cli start --bundler b --port N --no-interactive', () => {
    assert.deepEqual(startArgs(launch(), 8082), [
      '/ws/apps/host/node_modules/react-native/cli.js',
      'start',
      '--bundler',
      'rspack',
      '--port',
      '8082',
      '--no-interactive',
    ]);
  });

  it('adds --config, --platform and --standalone in upstream order', () => {
    assert.deepEqual(
      startArgs(
        launch({
          bundler: 'webpack',
          config: '/ws/apps/host/webpack.dev.js',
          platform: 'android',
          standalone: true,
        }),
        9000
      ).slice(1),
      [
        'start',
        '--bundler',
        'webpack',
        '--config',
        '/ws/apps/host/webpack.dev.js',
        '--port',
        '9000',
        '--no-interactive',
        '--platform',
        'android',
        '--standalone',
      ]
    );
  });

  it('Re.Pack 5.x shape: omits --bundler and --standalone, keeps the rest', () => {
    assert.deepEqual(
      startArgs(
        launch({
          startOptions: REPACK5,
          config: '/ws/c.js',
          platform: 'ios',
          standalone: true,
        }),
        8082
      ).slice(1),
      [
        'start',
        '--config',
        '/ws/c.js',
        '--port',
        '8082',
        '--no-interactive',
        '--platform',
        'ios',
      ]
    );
  });

  it('only passes --no-interactive, --platform and --config when declared', () => {
    assert.deepEqual(
      startArgs(
        launch({
          startOptions: ['--port'],
          config: '/ws/c.js',
          platform: 'ios',
        }),
        1
      ).slice(1),
      ['start', '--port', '1']
    );
  });

  it('an undetermined option set omits --bundler/--standalone, keeps the long-standing flags', () => {
    const { startOptions: _omit, ...rest } = launch({
      platform: 'android',
      standalone: true,
    });
    assert.deepEqual(startArgs(rest, 8081).slice(1), [
      'start',
      '--port',
      '8081',
      '--no-interactive',
      '--platform',
      'android',
    ]);
  });

  it('a null port is display-only (`<auto>`)', () => {
    assert.ok(startArgs(launch(), null).includes('<auto>'));
  });
});

describe('cliInvocation / shim launches', () => {
  it('prefers the shim; a .cmd shim needs a shell; no shim falls back to node', () => {
    assert.deepEqual(cliInvocation({ cli: '/c.js', shim: '/a/.bin/react-native' }), {
      file: '/a/.bin/react-native',
    });
    assert.deepEqual(cliInvocation({ cli: '/c.js', shim: 'C:\\a\\.bin\\react-native.cmd' }), {
      file: 'C:\\a\\.bin\\react-native.cmd',
      shell: true,
    });
    assert.deepEqual(cliInvocation({ cli: '/c.js' }), {
      file: process.execPath,
      cli: '/c.js',
    });
  });

  it('a shim launch passes no script and shows the shim relative to cwd', () => {
    const { cli: _cli, ...shimmed } = launch({
      file: '/ws/apps/host/node_modules/.bin/react-native',
    });
    assert.deepEqual(startArgs(shimmed, 8081).slice(0, 2), ['start', '--bundler']);
    assert.equal(
      describeLaunch(shimmed, 8081, '/ws/apps/host'),
      'node_modules/.bin/react-native start --bundler rspack --port 8081 --no-interactive'
    );
  });
});

describe('describeLaunch', () => {
  it('shows a command verbatim', () => {
    assert.equal(
      describeLaunch({ kind: 'command', command: 'pnpm start' }, 8081, '/ws'),
      'pnpm start'
    );
  });

  it('shows `node <cli relative to cwd> start ...` without the node path', () => {
    assert.equal(
      describeLaunch(launch(), 8081, '/ws/apps/host'),
      'node node_modules/react-native/cli.js start --bundler rspack --port 8081 --no-interactive'
    );
  });

  it('keeps an absolute cli when it lives outside the cwd; quotes spaces', () => {
    const line = describeLaunch(
      launch({ cli: '/store/rn/cli.js', config: '/ws/my app/rspack.config.js' }),
      null,
      '/ws/apps/host'
    );
    assert.match(line, /^node \/store\/rn\/cli\.js start /);
    assert.match(line, /--config "\/ws\/my app\/rspack\.config\.js"/);
    assert.match(line, /--port <auto>/);
  });
});
