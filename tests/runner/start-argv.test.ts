// Pure unit tests for the default-argv rules: bundler detection, argv
// building and the readable command line. No fs, no spawn.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeLaunch,
  detectBundler,
  startArgs,
  type DevLaunch,
} from '../../src/runner/start-argv.js';

type ArgvLaunch = Extract<DevLaunch, { kind: 'argv' }>;

const launch = (extra: Partial<ArgvLaunch> = {}): ArgvLaunch => ({
  kind: 'argv',
  file: '/usr/bin/node',
  cli: '/ws/apps/host/node_modules/react-native/cli.js',
  bundler: 'rspack',
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

  it('a null port is display-only (`<auto>`)', () => {
    assert.ok(startArgs(launch(), null).includes('<auto>'));
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
