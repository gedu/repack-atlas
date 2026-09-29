// WorkspaceConfigReader adapter tests. The fixture-driven cases are ported
// from `findConfigPath` / `loadFederationConfig` blocks of
// `packages/repack/src/commands/federation/__tests__/configFile.test.ts`
// (callstack/repack branch `feat/federation-shared-config` @ c5df67f0);
// fixtures live in tests/fixtures/adapters/ (see its README). The throwing
// `ConfigFileInvalidError` of upstream becomes the typed `invalid` result.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createNodeProjectFs,
  createWorkspaceConfigReader,
} from '../../src/adapters/index.js';
import { FEDERATION_CONFIG_FILENAME } from '../../src/core/index.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'adapters'
);
const VALID_DIR = path.join(fixturesDir, 'config-valid');

const reader = createWorkspaceConfigReader(createNodeProjectFs());

let tmpDir: string;
// Truncated JSON built at runtime, never committed (upstream pattern: a
// malformed .json in-tree breaks repo-wide tooling).
let malformedDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-config-'));
  malformedDir = path.join(tmpDir, 'config-malformed');
  fs.mkdirSync(malformedDir);
  fs.writeFileSync(
    path.join(malformedDir, FEDERATION_CONFIG_FILENAME),
    '{ "host": { "manifest":\n'
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findConfigPath', () => {
  it('finds the file in the given directory', async () => {
    assert.strictEqual(
      await reader.findConfigPath(VALID_DIR),
      path.join(VALID_DIR, FEDERATION_CONFIG_FILENAME)
    );
  });

  it('walks up from a nested directory', async () => {
    assert.strictEqual(
      await reader.findConfigPath(path.join(VALID_DIR, 'apps', 'store')),
      path.join(VALID_DIR, FEDERATION_CONFIG_FILENAME)
    );
  });

  it('takes the first hit walking up', async () => {
    assert.strictEqual(
      await reader.findConfigPath(path.join(fixturesDir, 'config-walkup', 'nested')),
      path.join(fixturesDir, 'config-walkup', 'nested', FEDERATION_CONFIG_FILENAME)
    );
  });

  it('returns null when nothing exists up the tree', async () => {
    const isolated = path.join(tmpDir, 'deep', 'nested');
    fs.mkdirSync(isolated, { recursive: true });
    // /tmp trees never carry a repack-federation.json upward.
    assert.strictEqual(await reader.findConfigPath(isolated), null);
  });
});

describe('load', () => {
  it('loads a valid document preserving optional fields', async () => {
    const result = await reader.load(VALID_DIR);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.strictEqual(
      result.filePath,
      path.join(VALID_DIR, FEDERATION_CONFIG_FILENAME)
    );
    assert.deepStrictEqual(result.config.remotes.store, {
      manifest: './manifests/store.json',
      root: './apps/store',
      standalone: true,
      port: 8082,
    });
  });

  it('classifies malformed JSON as invalid naming the file, never a stack', async () => {
    const result = await reader.load(malformedDir);
    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') return;
    assert.strictEqual(
      result.filePath,
      path.join(malformedDir, FEDERATION_CONFIG_FILENAME)
    );
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0]!, /is not valid JSON/);
    assert.doesNotMatch(result.reasons[0]!, /\n\s+at\s/);
  });

  it('classifies schema violations as invalid with exact field-path reasons', async () => {
    const result = await reader.load(path.join(fixturesDir, 'config-invalid'));
    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') return;
    assert.deepStrictEqual(result.reasons, [
      'host.manifest is required (string)',
    ]);
  });

  it('reports missing with nothing to load (never throws)', async () => {
    const isolated = path.join(tmpDir, 'empty');
    fs.mkdirSync(isolated, { recursive: true });
    assert.deepEqual(await reader.load(isolated), { status: 'missing' });
  });
});

describe('read (WorkspaceConfigReader port surface)', () => {
  it('returns the parsed config for a valid document', async () => {
    const config = (await reader.read(VALID_DIR)) as {
      host: { manifest: string };
    };
    assert.equal(config.host.manifest, './manifests/host.json');
  });

  it('returns null for missing and for invalid alike', async () => {
    const isolated = path.join(tmpDir, 'read-null');
    fs.mkdirSync(isolated, { recursive: true });
    assert.strictEqual(await reader.read(isolated), null);
    assert.strictEqual(await reader.read(malformedDir), null);
  });
});
