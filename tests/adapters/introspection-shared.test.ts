// IntrospectionPlugin `shared` option: the Atlas array and the Module
// Federation map normalize to the same facts array, and a missing `version`
// is resolved from the installed package with honest confidence.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { IntrospectionPlugin } from '../../src/repack-bridge/introspection-plugin.js';
import type { IntrospectionSharedInput } from '../../src/repack-bridge/shared-map.js';
import { validateIntrospectionFacts } from '../../src/core/introspection-types.js';

let tmpDir: string;

function writePackage(name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(tmpDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, ...manifest })
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-shared-'));
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'app', version: '0.0.0' })
  );
  writePackage('react', { version: '19.2.8', main: 'index.js' });
  // `exports` hides ./package.json: resolution must walk up from the entry.
  writePackage('hidden-exports', {
    version: '3.1.4',
    exports: { '.': './index.js' },
  });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function facts(shared: IntrospectionSharedInput) {
  return new IntrospectionPlugin({
    name: 'app',
    shared,
    appRoot: tmpDir,
  }).buildDocument().shared;
}

describe('IntrospectionPlugin shared shapes', () => {
  it('keeps the array form untouched', () => {
    const array = [
      { name: 'react', version: '19.0.0', singleton: true, eager: false },
    ];
    assert.deepEqual(facts(array), array);
  });

  it('accepts the Module Federation map and declared versions stay static', () => {
    const result = facts({
      react: {
        singleton: true,
        eager: false,
        requiredVersion: '19.2.8',
        version: '19.2.8',
      },
    });
    assert.deepEqual(result, [
      {
        name: 'react',
        singleton: true,
        eager: false,
        requiredVersion: '19.2.8',
        version: '19.2.8',
      },
    ]);
  });

  it('reads a string value as requiredVersion and ignores unrelated MF keys', () => {
    const result = facts({
      lodash: '^4.17.0',
      zustand: { import: false, shareScope: 'default', requiredVersion: false },
    });
    assert.deepEqual(result, [
      { name: 'lodash', requiredVersion: '^4.17.0' },
      { name: 'zustand' },
    ]);
  });

  it('accepts an MF name array, including map items', () => {
    const result = facts(['lodash', { zustand: '1.0.0' }]);
    assert.deepEqual(result, [
      { name: 'lodash' },
      { name: 'zustand', requiredVersion: '1.0.0' },
    ]);
  });

  it('rejects a value that is neither a string nor an object', () => {
    assert.throws(
      () => facts({ react: 42 } as never),
      /shared\["react"\] must be a version string or an object/
    );
  });
});

describe('IntrospectionPlugin shared version resolution', () => {
  it('resolves a missing version from the installed package, marked heuristic', () => {
    const [entry] = facts({ react: { singleton: true } });
    assert.equal(entry?.version, '19.2.8');
    assert.equal(entry?.versionConfidence, 'heuristic');
  });

  it('resolves through package exports that hide package.json', () => {
    const [entry] = facts({ 'hidden-exports': '^3.0.0' });
    assert.equal(entry?.version, '3.1.4');
    assert.equal(entry?.versionConfidence, 'heuristic');
  });

  it('resolves packageName when the share key is an alias', () => {
    const [entry] = facts({ 'my-react': { packageName: 'react' } });
    assert.equal(entry?.name, 'my-react');
    assert.equal(entry?.version, '19.2.8');
  });

  it('leaves the version absent for an unresolvable package, without throwing', () => {
    const [entry] = facts({ 'not-installed-anywhere': { singleton: true } });
    assert.equal(entry?.version, undefined);
    assert.equal(entry?.versionConfidence, undefined);
  });

  it('resolves array-form entries without a version too', () => {
    const [entry] = facts([{ name: 'react', singleton: true }]);
    assert.equal(entry?.version, '19.2.8');
    assert.equal(entry?.versionConfidence, 'heuristic');
  });

  it('does not resolve when no root is known', () => {
    const [entry] = new IntrospectionPlugin({
      name: 'app',
      shared: { react: {} },
    }).buildDocument().shared;
    assert.equal(entry?.version, undefined);
  });

  it('falls back to the compiler context and writes a valid facts file', () => {
    const plugin = new IntrospectionPlugin({
      name: 'app',
      shared: { react: { singleton: true } },
    });
    plugin.apply({ context: tmpDir });
    const written = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, '.repack-atlas', 'introspection.json'),
        'utf-8'
      )
    ) as unknown;
    assert.deepEqual(validateIntrospectionFacts(written), []);
    assert.equal(
      (written as { shared: { version?: string }[] }).shared[0]?.version,
      '19.2.8'
    );
  });

  it('validation rejects an unknown versionConfidence', () => {
    const reasons = validateIntrospectionFacts({
      schemaVersion: 1,
      name: 'app',
      exposes: [],
      remotes: {},
      shared: [{ name: 'react', versionConfidence: 'static' }],
    });
    assert.deepEqual(reasons, ['shared[0].versionConfidence must be "heuristic"']);
  });
});
