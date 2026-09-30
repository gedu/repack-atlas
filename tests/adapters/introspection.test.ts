// ConfigIntrospector adapter + IntrospectionPlugin tests: the plugin writes
// `.repack-atlas/introspection.json`, the reader validates it. Malformed
// documents must come back as typed `invalid`, never guessed around.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { IntrospectionPlugin } from '../../src/repack-bridge/introspection-plugin.js';
import {
  createConfigIntrospector,
  createNodeProjectFs,
  introspectionFactsPath,
} from '../../src/adapters/index.js';

const introspector = createConfigIntrospector(createNodeProjectFs());
let tmpDir: string;
let appRoot: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-introspect-'));
  appRoot = path.join(tmpDir, 'apps', 'mini');
  fs.mkdirSync(appRoot, { recursive: true });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFacts(app: string, content: string): string {
  const root = path.join(tmpDir, app);
  fs.mkdirSync(path.dirname(introspectionFactsPath(root)), { recursive: true });
  fs.writeFileSync(introspectionFactsPath(root), content);
  return root;
}

describe('IntrospectionPlugin (writer side)', () => {
  it('writes the declaration file under .repack-atlas/', () => {
    const plugin = new IntrospectionPlugin({
      name: 'MiniApp',
      role: 'remote',
      exposes: ['./Screen'],
      remotes: {},
      shared: [{ name: 'react', singleton: true, version: '19.0.0' }],
      port: 8082,
      native: { reactNativeVersion: '0.81.0', newArch: true },
      appRoot,
    });
    plugin.apply({ context: path.join(tmpDir, 'ignored') });

    const written = JSON.parse(
      fs.readFileSync(introspectionFactsPath(appRoot), 'utf-8')
    );
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.name, 'MiniApp');
    assert.equal(written.port, 8082);
    assert.deepEqual(written.exposes, ['./Screen']);
  });

  it('falls back to the compiler context as app root', () => {
    const contextRoot = path.join(tmpDir, 'context-app');
    fs.mkdirSync(contextRoot, { recursive: true });
    new IntrospectionPlugin({ name: 'Ctx' }).apply({ context: contextRoot });
    assert.ok(fs.existsSync(introspectionFactsPath(contextRoot)));
  });

  it('rejects a bad declaration at construction-time validation', () => {
    const plugin = new IntrospectionPlugin({
      name: 'Bad',
      // port as a string, a classic user typo
      port: '8082' as unknown as number,
      appRoot,
    });
    assert.throws(() => plugin.apply({}), /port must be a number/);
  });

  it('fails loudly with no app root anywhere', () => {
    assert.throws(
      () => new IntrospectionPlugin({ name: 'Homeless' }).apply({}),
      /no app root/
    );
  });
});

describe('createConfigIntrospector (reader side)', () => {
  it('reports missing for an app that never opted in', async () => {
    const result = await introspector.read(path.join(tmpDir, 'plain-app'));
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'missing');
    assert.match(result.message, /repack-atlas\/introspection/);
  });

  it('reads and types a valid document', async () => {
    const root = writeFacts(
      'ok-app',
      JSON.stringify({
        schemaVersion: 1,
        name: 'Store',
        exposes: ['./Button'],
        remotes: { Cart: 'http://127.0.0.1:8083' },
        shared: [{ name: 'react', version: '19.0.0', singleton: true }],
        port: 8082,
        role: 'remote',
        native: { platforms: ['ios'], nativeModules: ['react-native-svg'] },
      })
    );
    const result = await introspector.read(root);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.facts.name, 'Store');
    assert.deepEqual(result.facts.exposes, ['./Button']);
    assert.equal(result.facts.port, 8082);
    assert.deepEqual(result.facts.native?.nativeModules, ['react-native-svg']);
    assert.equal(result.resolvedFrom, introspectionFactsPath(root));
  });

  it('tolerates unknown keys (forward-compatible schemaVersion)', async () => {
    const root = writeFacts(
      'extra-keys-app',
      JSON.stringify({
        schemaVersion: 1,
        name: 'Future',
        exposes: [],
        remotes: {},
        shared: [],
        someFutureField: true,
      })
    );
    const result = await introspector.read(root);
    assert.equal(result.status, 'ok');
  });

  it('classifies malformed JSON as invalid', async () => {
    const root = writeFacts('broken-json', '{ "schemaVersion": ');
    const result = await introspector.read(root);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'invalid');
    assert.match(result.message, /not valid JSON/);
  });

  it('classifies schema violations as invalid naming every reason', async () => {
    const root = writeFacts(
      'bad-schema',
      JSON.stringify({
        schemaVersion: 2,
        exposes: 'not-an-array',
        shared: [{ version: 12 }],
      })
    );
    const result = await introspector.read(root);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'invalid');
    assert.match(result.message, /schemaVersion is required/);
    assert.match(result.message, /name is required/);
    assert.match(result.message, /exposes is required/);
    assert.match(result.message, /shared\[0\]\.name is required/);
  });
});
