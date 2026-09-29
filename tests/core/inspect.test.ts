// Ported coverage for the machine parts of upstream `inspect.ts`
// (callstack/repack @ c5df67f0): the formatting function itself. Upstream
// inspect.test.ts additionally exercised the CLI command wiring, which is
// Atlas CLI territory (T7) and intentionally not ported here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { formatManifest } from '../../src/core/inspect.js';
import type { ParsedFederationManifest } from '../../src/core/manifest-types.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'fixtures',
      'core',
      'host.json'
    ),
    'utf-8'
  )
) as ParsedFederationManifest;

describe('formatManifest', () => {
  it('renders identity, shared, remotes and native sections from the fixture', () => {
    const text = formatManifest(fixture);
    assert.ok(text.includes('shell'));
    assert.ok(text.includes('type:  host'));
    assert.ok(text.includes('shared (3):'));
    assert.ok(text.includes('react'));
    assert.ok(text.includes('singleton eager'));
    assert.ok(text.includes('remotes (1):'));
    assert.ok(text.includes('http://localhost:5001/store.container.js'));
    assert.ok(text.includes('native modules (2):'));
    assert.ok(text.includes('react-native-reanimated'));
    assert.ok(text.includes('note: Native module list covers statically imported modules.'));
  });

  it('does not crash on a manifest with all optional blocks absent', () => {
    const text = formatManifest({ manifestVersion: 1, id: 'bare', name: 'bare' });
    assert.ok(text.includes('type:  unknown'));
    assert.ok(text.includes('shared (0):'));
    assert.ok(text.includes('version: unknown'));
  });
});
