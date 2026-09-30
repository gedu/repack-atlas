// Ported upstream config validation tests: `validateFederationConfig` and
// `describeJsonParseFailure` blocks of
// `packages/repack/src/commands/federation/__tests__/configFile.test.ts`
// (callstack/repack branch `feat/federation-shared-config` @ c5df67f0),
// jest → node:test. Assertions unchanged; the throwing loader parts moved
// to tests/adapters/workspace-config.test.ts with the filesystem adapter.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeJsonParseFailure,
  validateFederationConfig,
} from '../../src/core/federation-config.js';

describe('validateFederationConfig', () => {
  it('accepts the minimal document', () => {
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: './shell/build' },
        remotes: { store: { manifest: 'http://localhost:8082' } },
      }),
      []
    );
  });

  it('accepts the full document with every optional field', () => {
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: './shell/build', root: '.' },
        remotes: {
          store: {
            manifest: './store/build',
            root: './apps/store',
            standalone: true,
            port: 8082,
          },
        },
      }),
      []
    );
  });

  it('rejects an unknown top-level key naming its path', () => {
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: '.' },
        remotes: {},
        bogus: true,
      }),
      ['bogus is not a known field']
    );
  });

  it('rejects unknown nested keys naming the full field path', () => {
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: '.', bogus: 1 },
        remotes: { store: { manifest: '.', bogus: 2 } },
      }),
      [
        'host.bogus is not a known field',
        'remotes.store.bogus is not a known field',
      ]
    );
  });

  it('names the field path for every schema violation', () => {
    assert.deepStrictEqual(
      validateFederationConfig({ host: { root: '.' }, remotes: {} }),
      ['host.manifest is required (string)']
    );
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: '.' },
        remotes: { store: { manifest: '.', standalone: 'yes' } },
      }),
      ['remotes.store.standalone must be a boolean']
    );
    assert.deepStrictEqual(
      validateFederationConfig({ host: { manifest: 42 }, remotes: {} }),
      ['host.manifest is required (string)']
    );
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: '.' },
        remotes: { store: {} },
      }),
      ['remotes.store.manifest is required (string)']
    );
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: '.' },
        remotes: { store: { manifest: '.', port: '8082' } },
      }),
      ['remotes.store.port must be a number']
    );
  });

  it('rejects remotes as an array', () => {
    assert.deepStrictEqual(
      validateFederationConfig({
        host: { manifest: '.' },
        remotes: [{ manifest: '.' }],
      }),
      ['remotes must be a name-keyed object, not an array']
    );
  });
});

describe('describeJsonParseFailure', () => {
  it('derives line/column from a position-bearing message', () => {
    const raw = `{\n  "host": \n}\n`;
    // V8-style position-bearing message (older V8): byte 13 is the `}`,
    // first character of line 3.
    assert.strictEqual(
      describeJsonParseFailure(
        raw,
        new SyntaxError('Unexpected token } in JSON at position 13')
      ),
      'is not valid JSON: Unexpected token } in JSON at position 13 (line 3, column 1)'
    );
  });

  it('reports the message verbatim when no position is available', () => {
    const raw = `{\n  "host": \n}\n`;
    // Newer V8 exposes no position — the message rides verbatim.
    assert.strictEqual(
      describeJsonParseFailure(
        raw,
        new SyntaxError('Unexpected token } in some recent V8')
      ),
      'is not valid JSON: Unexpected token } in some recent V8'
    );
  });
});
