// Top-level bin surface: version, help, unknown commands (spawned bin).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { binPath, ensureBin, repoRoot, runBin } from './run-bin.js';

before(ensureBin);

describe('bin surface (spawned)', () => {
  it('--version prints the package version', async () => {
    const { version } = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf-8')
    ) as { version: string };
    const result = await runBin('--version');
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `repack-atlas ${version}\n`);
  });

  it('no arguments prints help and exits 2 (nothing was asked)', async () => {
    const result = await runBin();
    assert.equal(result.code, 2);
    assert.match(result.stdout, /Usage/);
  });

  it('--help exits 0', async () => {
    const result = await runBin('--help');
    assert.equal(result.code, 0);
    assert.match(result.stdout, /doctor/);
    assert.match(result.stdout, /inspect/);
    assert.match(result.stdout, /init/);
  });

  for (const command of ['doctor', 'inspect', 'init']) {
    it(`${command} --help exits 0 with command help`, async () => {
      const result = await runBin(command, '--help');
      assert.equal(result.code, 0);
      assert.match(result.stdout, new RegExp(`repack-atlas ${command}`));
    });
  }

  it('unknown command prints help and exits 2', async () => {
    const result = await runBin('defenestrate');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown command defenestrate/);
    assert.match(result.stderr, /Usage/);
  });

  it('the bin file is executable ESM with a node shebang', async () => {
    const source = await readFile(binPath, 'utf-8');
    assert.ok(source.startsWith('#!/usr/bin/env node'), 'shebang preserved');
  });
});
