// ProjectFs adapter tests on a temp fixture tree (the port exists so tests
// replace the user project with fixtures — PRD §6.3).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createNodeProjectFs,
  DEFAULT_WALK_IGNORE_DIRS,
} from '../../src/adapters/index.js';

const projectFs = createNodeProjectFs();
let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fs-'));
  fs.mkdirSync(path.join(root, 'src', 'features'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
  fs.writeFileSync(path.join(root, 'src', 'features', 'Screen.tsx'), '');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'build', 'bundle.js'), '');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('stat / exists / readFile / readdir', () => {
  it('stats files and directories', async () => {
    const file = await projectFs.stat(path.join(root, 'package.json'));
    assert.deepEqual(file, { isDirectory: false, sizeBytes: 2 });
    const dir = await projectFs.stat(path.join(root, 'src'));
    assert.equal(dir?.isDirectory, true);
  });

  it('returns null and false for absent paths without throwing', async () => {
    assert.equal(await projectFs.stat(path.join(root, 'nope')), null);
    assert.equal(await projectFs.exists(path.join(root, 'nope')), false);
    assert.equal(await projectFs.readFile(path.join(root, 'nope')), null);
    assert.deepEqual(await projectFs.readdir(path.join(root, 'nope')), []);
  });

  it('reads utf-8 content and directory entries', async () => {
    assert.equal(await projectFs.readFile(path.join(root, 'package.json')), '{}');
    assert.deepEqual((await projectFs.readdir(path.join(root, 'src'))).sort(), [
      'features',
      'index.ts',
    ]);
  });

  it('exists() is true for both files and dirs', async () => {
    assert.equal(await projectFs.exists(path.join(root, 'package.json')), true);
    assert.equal(await projectFs.exists(path.join(root, 'src')), true);
  });
});

describe('walk', () => {
  it('walks recursively, relative and sorted, pruning default noise', async () => {
    const entries = await projectFs.walk(root);
    assert.deepEqual(entries, [
      'package.json',
      'src/features/Screen.tsx',
      'src/index.ts',
    ]);
    assert.ok(DEFAULT_WALK_IGNORE_DIRS.includes('node_modules'));
  });

  it('honors a custom ignore list', async () => {
    const entries = await projectFs.walk(root, {
      ignoreDirNames: ['features', 'build', 'node_modules'],
    });
    assert.deepEqual(entries, ['package.json', 'src/index.ts']);
  });

  it('caps results at maxEntries', async () => {
    const entries = await projectFs.walk(root, { maxEntries: 1 });
    assert.ok(entries.length <= 1);
  });

  it('returns [] for a nonexistent root', async () => {
    assert.deepEqual(await projectFs.walk(path.join(root, 'nope')), []);
  });
});
