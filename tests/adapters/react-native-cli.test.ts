// ReactNativeCliResolver adapter: resolves the CLI from the APP's own root
// through the user project's module graph (createRequire), never from
// Atlas's tree or PATH. Fixture apps are built under os.tmpdir().

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createReactNativeCliResolver } from '../../src/adapters/index.js';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-rncli-')));
after(() => rmSync(root, { recursive: true, force: true }));

function rnPackage(dir: string, bin: unknown, script = 'cli.js'): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'react-native', version: '0.0.0', bin })
  );
  mkdirSync(path.dirname(path.join(dir, script)), { recursive: true });
  writeFileSync(path.join(dir, script), '');
  return path.join(dir, script);
}

const resolver = createReactNativeCliResolver();

describe('createReactNativeCliResolver', () => {
  it('resolves bin.react-native (object form) from the app root', () => {
    const app = path.join(root, 'plain');
    const cli = rnPackage(
      path.join(app, 'node_modules', 'react-native'),
      { 'react-native': './cli.js' }
    );
    assert.deepEqual(resolver.resolve(app), { status: 'ok', cli });
  });

  it('accepts the string bin form and a nested script path', () => {
    const app = path.join(root, 'string-bin');
    const cli = rnPackage(
      path.join(app, 'node_modules', 'react-native'),
      './scripts/cli.js',
      'scripts/cli.js'
    );
    assert.deepEqual(resolver.resolve(app), { status: 'ok', cli });
  });

  it('walks up to a hoisted node_modules, like the app itself would', () => {
    const workspace = path.join(root, 'hoisted');
    const cli = rnPackage(
      path.join(workspace, 'node_modules', 'react-native'),
      { 'react-native': './cli.js' }
    );
    const app = path.join(workspace, 'apps', 'host');
    mkdirSync(app, { recursive: true });
    assert.deepEqual(resolver.resolve(app), { status: 'ok', cli });
  });

  it('follows a pnpm-style symlinked install', (t) => {
    const app = path.join(root, 'pnpm');
    const target = path.join(app, 'node_modules', '.pnpm', 'rn@1', 'node_modules', 'react-native');
    const cli = rnPackage(target, { 'react-native': './scripts/cli.js' }, 'scripts/cli.js');
    try {
      symlinkSync(target, path.join(app, 'node_modules', 'react-native'), 'dir');
    } catch {
      t.skip('symlinks are not available here');
      return;
    }
    assert.deepEqual(resolver.resolve(app), { status: 'ok', cli });
  });

  it('never borrows a sibling app’s install', () => {
    const workspace = path.join(root, 'siblings');
    rnPackage(
      path.join(workspace, 'apps', 'a', 'node_modules', 'react-native'),
      { 'react-native': './cli.js' }
    );
    const b = path.join(workspace, 'apps', 'b');
    mkdirSync(b, { recursive: true });
    const result = resolver.resolve(b);
    assert.equal(result.status, 'failed');
  });

  it('reports the app\'s .bin/react-native shim when one exists, walking up like Node', (t) => {
    if (process.platform === 'win32') return t.skip('posix shim name');
    const workspace = path.join(root, 'shimmed');
    const cli = rnPackage(path.join(workspace, 'node_modules', 'react-native'), {
      'react-native': './cli.js',
    });
    const app = path.join(workspace, 'apps', 'a');
    mkdirSync(app, { recursive: true });
    assert.deepEqual(resolver.resolve(app), { status: 'ok', cli }, 'no shim yet');
    const bin = path.join(app, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(cli, path.join(bin, 'react-native'));
    assert.deepEqual(resolver.resolve(app), {
      status: 'ok',
      cli,
      shim: path.join(bin, 'react-native'),
    });
  });

  it('accepts a pnpm-style text shim that names this cli (cmd-shim-target)', (t) => {
    if (process.platform === 'win32') return t.skip('posix shim name');
    const app = path.join(root, 'pnpmshim');
    const cli = rnPackage(path.join(app, 'node_modules', 'react-native'), {
      'react-native': './cli.js',
    });
    const bin = path.join(app, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'react-native'),
      `#!/bin/sh\nexec node "$basedir/../react-native/cli.js" "$@"\n# cmd-shim-target=${cli}\n`
    );
    assert.equal(
      (resolver.resolve(app) as { shim?: string }).shim,
      path.join(bin, 'react-native')
    );
  });

  it('skips a hoisted shim that belongs to a different react-native', (t) => {
    if (process.platform === 'win32') return t.skip('posix shim name');
    const workspace = path.join(root, 'mismatch');
    const otherCli = rnPackage(
      path.join(workspace, 'node_modules', 'react-native'),
      { 'react-native': './cli.js' }
    );
    const hoistedBin = path.join(workspace, 'node_modules', '.bin');
    mkdirSync(hoistedBin, { recursive: true });
    symlinkSync(otherCli, path.join(hoistedBin, 'react-native'));
    const app = path.join(workspace, 'apps', 'a');
    const ownCli = rnPackage(path.join(app, 'node_modules', 'react-native'), {
      'react-native': './cli.js',
    });
    // The app has its own react-native but no shim: the hoisted one is not its.
    assert.deepEqual(resolver.resolve(app), { status: 'ok', cli: ownCli });
  });

  it('a missing package fails naming the app root', () => {
    const app = path.join(root, 'missing');
    mkdirSync(app, { recursive: true });
    const result = resolver.resolve(app);
    assert.ok(result.status === 'failed');
    assert.ok(result.message.includes(app), result.message);
    assert.match(result.message, /cannot resolve the "react-native" package/);
  });

  it('a package without bin.react-native fails', () => {
    const app = path.join(root, 'nobin');
    rnPackage(path.join(app, 'node_modules', 'react-native'), { other: './x.js' });
    const result = resolver.resolve(app);
    assert.ok(result.status === 'failed');
    assert.match(result.message, /declares no "bin\.react-native"/);
  });
});

describe('createReactNativeCliResolver.startOptions', () => {
  function appWithConfig(name: string, file: string, source: string): string {
    const app = path.join(root, name);
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, file), source);
    return app;
  }

  it('reads the long flags of the registered start command (aliases and placeholders stripped)', () => {
    const app = appWithConfig(
      'opts-js',
      'react-native.config.js',
      `console.log('config noise');
module.exports = { commands: [
  { name: 'bundle', options: [{ name: '--dev' }] },
  { name: 'start', options: [
    { name: '--port <number>' },
    { name: '--no-interactive' },
    { name: '--reset-cache, --resetCache' },
  ] },
] };`
    );
    assert.deepEqual(resolver.startOptions(app), {
      status: 'ok',
      options: ['--port', '--no-interactive', '--reset-cache', '--resetCache'],
    });
  });

  it('accepts .cjs and ESM (.mjs default export) configs', () => {
    const cjs = appWithConfig(
      'opts-cjs',
      'react-native.config.cjs',
      "module.exports = { commands: [{ name: 'start', options: [{ name: '--bundler <t>' }] }] };"
    );
    assert.deepEqual(resolver.startOptions(cjs), { status: 'ok', options: ['--bundler'] });
    const mjs = appWithConfig(
      'opts-mjs',
      'react-native.config.mjs',
      "export default { commands: [{ name: 'start', options: [{ name: '--standalone' }] }] };"
    );
    assert.deepEqual(resolver.startOptions(mjs), { status: 'ok', options: ['--standalone'] });
  });

  it('a missing config is unknown, naming the app root', () => {
    const app = path.join(root, 'opts-none');
    mkdirSync(app, { recursive: true });
    const result = resolver.startOptions(app);
    assert.ok(result.status === 'unknown');
    assert.match(result.message, /no react-native\.config/);
    assert.ok(result.message.includes(app));
  });

  it('a config without a start command, or one that throws, is unknown', () => {
    const noStart = appWithConfig(
      'opts-nostart',
      'react-native.config.js',
      "module.exports = { commands: [{ name: 'bundle', options: [] }] };"
    );
    const r1 = resolver.startOptions(noStart);
    assert.ok(r1.status === 'unknown');
    assert.match(r1.message, /registers no "start" command/);
    const broken = appWithConfig(
      'opts-throws',
      'react-native.config.js',
      "throw new Error('kaboom');"
    );
    const r2 = resolver.startOptions(broken);
    assert.ok(r2.status === 'unknown');
    assert.match(r2.message, /kaboom/);
  });

  it('resolves modules the config requires from the app, not from Atlas', () => {
    const app = appWithConfig(
      'opts-require',
      'react-native.config.js',
      "module.exports = { commands: require('repack-stub') };"
    );
    const pkg = path.join(app, 'node_modules', 'repack-stub');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), '{"name":"repack-stub","main":"index.js"}');
    writeFileSync(
      path.join(pkg, 'index.js'),
      "module.exports = [{ name: 'start', options: [{ name: '--platform <s>' }] }];"
    );
    assert.deepEqual(resolver.startOptions(app), { status: 'ok', options: ['--platform'] });
  });
});

describe('createReactNativeCliResolver.startOptions failures', () => {
  function app(name: string, source: string): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'react-native.config.js'), source);
    return dir;
  }

  it('reports the exit code and the first stderr line', () => {
    const dir = app(
      'exitcode',
      "console.error('boom happened'); process.exit(3);"
    );
    const result = resolver.startOptions(dir);
    assert.ok(result.status === 'unknown');
    assert.match(result.message, /exited with code 3: boom happened/);
  });

  it('keeps a report printed before the process is killed late', () => {
    const dir = app(
      'slowexit',
      "module.exports = { commands: [{ name: 'start', options: [{ name: '--port <n>' }] }] };\nsetInterval(() => {}, 1000);"
    );
    process.env['ATLAS_RN_INSPECT_TIMEOUT_MS'] = '1500';
    try {
      assert.deepEqual(resolver.startOptions(dir), {
        status: 'ok',
        options: ['--port'],
      });
    } finally {
      delete process.env['ATLAS_RN_INSPECT_TIMEOUT_MS'];
    }
  });

  it('a hang without a report is unknown and says it timed out', () => {
    const dir = app(
      'hang',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);'
    );
    process.env['ATLAS_RN_INSPECT_TIMEOUT_MS'] = '1500';
    try {
      const result = resolver.startOptions(dir);
      assert.ok(result.status === 'unknown');
      assert.match(result.message, /timed out after 1\.5s/);
    } finally {
      delete process.env['ATLAS_RN_INSPECT_TIMEOUT_MS'];
    }
  });
});
