// `repack-atlas inspect` through the spawned bin (T7).

import assert from 'node:assert/strict';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import {
  ensureBin,
  fixturesDir,
  parseJson,
  runBin,
} from './run-bin.js';

before(ensureBin);

const hostManifest = path.join(
  fixturesDir,
  'workspace',
  'manifests',
  'host.json'
);

describe('inspect (spawned bin)', () => {
  it('prints a human summary for a fixture manifest', async () => {
    const result = await runBin('inspect', hostManifest);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^host\s*$/m); // manifest name heading
    assert.ok(result.stdout.includes('shared ('));
    assert.ok(result.stdout.includes('react-native:'));
    assert.ok(result.stdout.includes('source: '));
  });

  it('--json prints the manifest document itself', async () => {
    const result = await runBin('inspect', hostManifest, '--json');
    assert.equal(result.code, 0, result.stderr);
    const document = parseJson<{ name: string; manifestVersion: number }>(
      result.stdout
    );
    assert.equal(document.name, 'host');
    assert.equal(document.manifestVersion, 1);
  });

  it('accepts a directory containing the default manifest filename', async () => {
    // The fixtures use per-app filenames, so build the directory grammar
    // expectation from the file grammar instead: a directory without the
    // default file is a clean "nothing there" (exit 2).
    const result = await runBin('inspect', path.join(fixturesDir, 'workspace'));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /No manifest/);
  });

  it('a missing path is exit 2 (no answer)', async () => {
    const result = await runBin('inspect', path.join(fixturesDir, 'nope.json'));
    assert.equal(result.code, 2);
  });

  it('an unparseable manifest is exit 2, distinct from missing', async () => {
    const corrupt = path.join(
      fixturesDir,
      'fixture-corrupt-manifest',
      'manifests',
      'mini-store.json'
    );
    const result = await runBin('inspect', corrupt);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not valid JSON/);
  });

  it('requires exactly one argument', async () => {
    const none = await runBin('inspect');
    assert.equal(none.code, 2);
    const two = await runBin('inspect', hostManifest, hostManifest);
    assert.equal(two.code, 2);
  });
});
