// ManifestSource adapter tests: file grammar ported from
// `packages/repack/src/commands/federation/__tests__/loadManifest.test.ts`
// (callstack/repack @ c5df67f0) with the typed-result assertions of the
// Atlas port; the URL/dev-server grammar runs against a real loopback
// http.Server on an ephemeral port (real fetch, real timeout — no mocks),
// plus corrupt / oversized / missing / timeout cases.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createDevServerManifestSource,
  createFileManifestSource,
  createManifestSource,
  createNodeProjectFs,
  createUrlManifestSource,
} from '../../src/adapters/index.js';
import { DEFAULT_MANIFEST_FILENAME } from '../../src/repack-bridge/index.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'adapters'
);
const MANIFEST_FIXTURE = path.join(
  fixturesDir,
  'config-valid',
  'manifests',
  'host.json'
);

const fsPort = createNodeProjectFs();
const validManifestJson = fs.readFileSync(MANIFEST_FIXTURE, 'utf-8');

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-manifest-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('file source', () => {
  const source = createFileManifestSource(fsPort);

  it('loads a manifest from a file path', async () => {
    const result = await source.load(MANIFEST_FIXTURE);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.manifest.name, 'shell');
    assert.equal(result.resolvedFrom, MANIFEST_FIXTURE);
  });

  it('resolves the default filename inside a directory', async () => {
    const dir = path.join(tmpDir, 'manifest-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, DEFAULT_MANIFEST_FILENAME),
      validManifestJson
    );
    const result = await source.load(dir);
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(
      result.resolvedFrom,
      path.join(dir, DEFAULT_MANIFEST_FILENAME)
    );
  });

  it('reports a nonexistent path as missing', async () => {
    const result = await source.load(path.join(tmpDir, 'nope.json'));
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'missing');
  });

  it('reports a directory without the default file as missing', async () => {
    const empty = path.join(tmpDir, 'empty-dir');
    fs.mkdirSync(empty);
    const result = await source.load(empty);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'missing');
  });

  it('reports malformed JSON as corrupt', async () => {
    const bad = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(bad, '{ "manifestVersion": ');
    const result = await source.load(bad);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'corrupt');
    assert.match(result.message, /not valid JSON/);
  });

  it('reports a wrong-shape document as corrupt', async () => {
    const wrong = path.join(tmpDir, 'wrong.json');
    fs.writeFileSync(wrong, JSON.stringify({ hello: 'world' }));
    const result = await source.load(wrong);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'corrupt');
    assert.match(result.message, /manifestVersion/);
  });
});

/** Loopback server whose routes the URL tests drive. */
async function startServer(
  handler: (req: { url: string }) => { status: number; body: string }
): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer((req, res) => {
    const outcome = handler({ url: req.url ?? '/' });
    res.writeHead(outcome.status, { 'content-type': 'application/json' });
    res.end(outcome.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

describe('url source', () => {
  it('loads a manifest from a full .json URL', async () => {
    const { server, url } = await startServer(({ url }) =>
      url === '/mf.json'
        ? { status: 200, body: validManifestJson }
        : { status: 404, body: '{}' }
    );
    try {
      const result = await createUrlManifestSource().load(`${url}/mf.json`);
      assert.equal(result.status, 'ok');
      if (result.status !== 'ok') return;
      assert.equal(result.manifest.name, 'shell');
    } finally {
      server.close();
    }
  });

  it('appends the default manifest filename to a bare base URL', async () => {
    const seen: string[] = [];
    const { server, url } = await startServer(({ url }) => {
      seen.push(url);
      return { status: 200, body: validManifestJson };
    });
    try {
      const result = await createUrlManifestSource().load(url);
      assert.equal(result.status, 'ok');
      assert.deepStrictEqual(seen, [`/${DEFAULT_MANIFEST_FILENAME}`]);
    } finally {
      server.close();
    }
  });

  it('maps 404 to missing', async () => {
    const { server, url } = await startServer(() => ({
      status: 404,
      body: '{}',
    }));
    try {
      const result = await createUrlManifestSource().load(url);
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure, 'missing');
    } finally {
      server.close();
    }
  });

  it('maps 500 to corrupt (an answer exists but is unusable)', async () => {
    const { server, url } = await startServer(() => ({
      status: 500,
      body: 'boom',
    }));
    try {
      const result = await createUrlManifestSource().load(url);
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure, 'corrupt');
    } finally {
      server.close();
    }
  });

  it('maps corrupt bodies to corrupt', async () => {
    const { server, url } = await startServer(() => ({
      status: 200,
      body: 'not json at all',
    }));
    try {
      const result = await createUrlManifestSource().load(url);
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure, 'corrupt');
    } finally {
      server.close();
    }
  });

  it('caps the body size', async () => {
    const big = JSON.stringify({
      manifestVersion: 1,
      name: 'x'.repeat(64 * 1024),
    });
    const { server, url } = await startServer(() => ({
      status: 200,
      body: big,
    }));
    try {
      const result = await createUrlManifestSource({
        maxBytes: 1024,
      }).load(url);
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure, 'corrupt');
      assert.match(result.message, /exceeds the 1024-byte limit/);
    } finally {
      server.close();
    }
  });

  it('times out a hung server instead of hanging', async () => {
    const hung = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const port = (hung.address() as AddressInfo).port;
    try {
      const started = Date.now();
      const result = await createUrlManifestSource({ timeoutMs: 250 }).load(
        `http://127.0.0.1:${port}`
      );
      const elapsed = Date.now() - started;
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed') return;
      assert.equal(result.failure, 'missing');
      assert.ok(elapsed < 5_000, `timeout did not bound the request: ${elapsed}ms`);
    } finally {
      hung.closeAllConnections();
      hung.close();
    }
  });

  it('classifies a refused connection as missing', async () => {
    // Port 1 on loopback refuses immediately.
    const result = await createUrlManifestSource().load('http://127.0.0.1:1');
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.failure, 'missing');
  });
});

describe('dev-server source', () => {
  it('serves the 127.0.0.1:<port> convention', async () => {
    const { server, port } = await startServer(({ url }) =>
      url === `/${DEFAULT_MANIFEST_FILENAME}`
        ? { status: 200, body: validManifestJson }
        : { status: 404, body: '{}' }
    );
    try {
      const result = await createDevServerManifestSource(port).load();
      assert.equal(result.status, 'ok');
      if (result.status !== 'ok') return;
      assert.equal(
        result.resolvedFrom,
        `http://127.0.0.1:${port}/${DEFAULT_MANIFEST_FILENAME}`
      );
    } finally {
      server.close();
    }
  });

  it('refuses refs pointing off loopback', async () => {
    const source = createDevServerManifestSource(8081);
    const result = await source.load('http://evil.example.com');
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.match(result.message, /loopback/);
  });
});

describe('dispatching source', () => {
  it('routes URLs to the url grammar and paths to the file grammar', async () => {
    const { server, url } = await startServer(() => ({
      status: 200,
      body: validManifestJson,
    }));
    try {
      const source = createManifestSource(fsPort);
      const viaUrl = await source.load(`${url}/mf.json`);
      const viaFile = await source.load(MANIFEST_FIXTURE);
      assert.equal(viaUrl.status, 'ok');
      assert.equal(viaFile.status, 'ok');
    } finally {
      server.close();
    }
  });
});
