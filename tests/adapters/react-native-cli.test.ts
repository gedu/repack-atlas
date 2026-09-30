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
