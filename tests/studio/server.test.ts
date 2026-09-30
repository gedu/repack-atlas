// Integration tests for the Studio server: real sockets on a real ephemeral
// port, because the properties that matter (loopback bind, 405 on writes, 404
// on unknown paths, SSE push) do not exist without one.
//
// The route table is a security boundary (AGENTS.md rule 5: read-only forever,
// localhost only, manifests untrusted), so these tests are deliberately
// adversarial rather than illustrative.

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  buildFederationGraph,
  type AppStatusMap,
  type FederationConfig,
  type FederationGraph,
  type ParsedFederationManifest,
} from '../../src/core/index.js';
import {
  createStudioServer,
  firstFreeFrom,
  type StudioServer,
} from '../../src/studio/server.js';
import { createWorkspaceGraphSource } from '../../src/studio/workspace.js';
import { createFileManifestSource, createNodeProjectFs, createWorkspaceConfigReader } from '../../src/adapters/index.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

const hostManifest = {
  manifestVersion: 1,
  id: 'host',
  name: 'host',
  remotes: [
    {
      federationContainerName: 'wallet',
      moduleName: 'wallet',
      alias: 'wallet',
      entry: 'http://127.0.0.1:9000/wallet.container.js',
    },
  ],
} satisfies ParsedFederationManifest;

const walletManifest = {
  manifestVersion: 1,
  id: 'wallet',
  name: 'wallet',
  exposes: [{ id: 'wallet:Screen', name: 'Screen', path: './src/Screen' }],
} satisfies ParsedFederationManifest;

const config = {
  host: { manifest: './host.json' },
  remotes: { wallet: { manifest: './wallet.json', port: 9000 } },
} as FederationConfig;

let statuses: AppStatusMap = {};
let buildCalls = 0;

function graph(): FederationGraph {
  buildCalls += 1;
  return buildFederationGraph(
    config,
    [
      { name: 'host', role: 'host', manifest: hostManifest },
      { name: 'wallet', role: 'remote', manifest: walletManifest },
    ],
    [],
    { statuses }
  );
}

const server = createStudioServer({
  studioPort: 0,
  build: () => graph(),
  statuses: () => statuses,
});

const startedServers: StudioServer[] = [];

function base(): string {
  const address = server.address();
  assert.ok(address, 'server must be listening');
  return `http://127.0.0.1:${address.port}`;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw request helper: we need headers and status codes fetch would hide. */
function request(
  method: string,
  target: string,
  options: { headers?: Record<string, string> } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base()}${target}`,
      { method, headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Minimal SSE client: collects `event: graph` frames so a test can wait for the
 * Nth one. `firstGraphEvent` alone cannot prove `notify()` did anything, because
 * a fresh connection pushes a graph immediately — the queue is what makes the
 * push observable rather than incidental.
 */
class GraphStream {
  frames: string[] = [];
  private waiters: Array<(frame: string) => void> = [];
  private request: http.ClientRequest;
  private closed = false;

  constructor(port: number) {
    this.request = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' });
    this.request.on('error', () => {
      /* the server closes the stream on purpose in the close() test */
    });
    this.request.on('response', (response) => {
      response.setEncoding('utf-8');
      let buffer = '';
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let match: RegExpExecArray | null;
        const pattern = /event: graph\ndata: ([^\n]*)\n\n/g;
        while ((match = pattern.exec(buffer)) !== null) {
          this.frames.push(match[1]!);
          const waiter = this.waiters.shift();
          if (waiter) waiter(match[1]!);
        }
        // Keep only the unterminated tail.
        const lastBoundary = buffer.lastIndexOf('\n\n');
        if (lastBoundary !== -1) buffer = buffer.slice(lastBoundary + 2);
      });
    });
    this.request.end();
  }

  /** Resolves with the frame at `index`, waiting for it if needed. */
  at(index: number, timeoutMs = 3_000): Promise<string> {
    if (this.frames[index] !== undefined) return Promise.resolve(this.frames[index]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no graph frame #${index} (have ${this.frames.length})`)),
        timeoutMs
      );
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.request.destroy();
  }
}

function openStream(port = server.address()?.port): GraphStream {
  assert.ok(port, 'server must be listening');
  return new GraphStream(port);
}

after(async () => {
  await server.close();
  for (const instance of startedServers) await instance.close();
});

describe('Studio server startup', () => {
  it('listens on an ephemeral port on the loopback interface only', async () => {
    const port = await server.listen();
    const address = server.address();
    assert.equal(address?.port, port);
    assert.equal(address?.address, '127.0.0.1', 'must never bind a routable interface');
    assert.equal(server.url(), `http://127.0.0.1:${port}/`);
    assert.equal(await server.listen(), port, 'listen() is idempotent');
  });

  it('firstFreeFrom returns a bindable port at or above the requested one', async () => {
    const port = await firstFreeFrom(8099);
    assert.ok(port >= 8099, `${port} >= 8099`);
    // Prove it is really free by binding it.
    const probe = createStudioServer({
      studioPort: port,
      build: () => graph(),
      statuses: () => ({}),
    });
    startedServers.push(probe);
    assert.equal(await probe.listen(), port);
  });

  it('walks forward when the requested port is taken', async () => {
    const blocker = createStudioServer({
      studioPort: 0,
      build: () => graph(),
      statuses: () => ({}),
    });
    startedServers.push(blocker);
    const taken = await blocker.listen();
    const next = await firstFreeFrom(taken);
    assert.ok(next > taken, `${next} > ${taken}`);
  });
});

describe('Studio routes', () => {
  it('GET / serves the self-contained page', async () => {
    const response = await request('GET', '/');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/html/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.body, /^<!doctype html>/);
    assert.ok(response.body.includes('Federation Studio'));
  });

  it('HEAD / answers without a body', async () => {
    const response = await request('HEAD', '/');
    assert.equal(response.status, 200);
    assert.equal(response.body, '');
  });

  it('GET /api/graph returns the graph with injected statuses', async () => {
    statuses = { host: 'ready', wallet: 'bundling' };
    const response = await request('GET', '/api/graph');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'] ?? '', /application\/json/);

    const payload = JSON.parse(response.body) as FederationGraph;
    assert.deepEqual(
      payload.apps.map((app) => `${app.name}:${app.status}`),
      ['host:ready', 'wallet:bundling']
    );
    assert.deepEqual(
      payload.edges.map((edge) => `${edge.from}->${edge.to}`),
      ['host->wallet']
    );
    assert.deepEqual(payload.findings, []);
    statuses = {};
  });

  it('GET /api/graph is re-built per request, so a rebuild shows up', async () => {
    const before = buildCalls;
    await request('GET', '/api/graph');
    await request('GET', '/api/graph');
    assert.ok(buildCalls >= before + 2, 'no cached graph on the read path');
  });

  it('no CORS header anywhere: only same-origin pages can read the API', async () => {
    for (const target of ['/', '/api/graph']) {
      const response = await request('GET', target);
      assert.equal(
        response.headers['access-control-allow-origin'],
        undefined,
        `${target} must not opt any origin in`
      );
    }
  });
});

describe('Studio refuses everything that could mutate state', () => {
  const writeMethods = ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

  for (const method of writeMethods) {
    it(`${method} /api/graph -> 405 with Allow: GET, HEAD`, async () => {
      const response = await request(method, '/api/graph');
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'GET, HEAD');
      assert.match(response.body, /read-only/);
    });

    it(`${method} / -> 405`, async () => {
      const response = await request(method, '/');
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'GET, HEAD');
    });
  }

  it('unknown paths 404 without touching the filesystem', async () => {
    const attempts = [
      '/../package.json',
      '/../../package.json',
      '/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
      '/api/graph/../secrets',
      '/api/graph/extra',
      '/api/events/nope',
      '/favicon.ico',
      '/repack-federation-manifest.json',
    ];
    for (const attempt of attempts) {
      // `request` passes the path through; http.request normalizes some of
      // these client-side, so also exercise the raw form below.
      const response = await request('GET', attempt);
      assert.equal(response.status, 404, `${attempt} must 404, got ${response.status}`);
      assert.doesNotMatch(response.body, /"name": "repack-atlas"/, `${attempt} leaked a file`);
    }
  });

  it('a traversal that survives client normalization still 404s', async () => {
    const raw = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.address()?.port, method: 'GET', path: '/%2e%2e%2f%2e%2e%2fpackage.json' },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(raw.status, 404);
    assert.doesNotMatch(raw.body, /repack-atlas/);
  });
});

describe('Studio SSE stream', () => {
  it('pushes the current graph on connect and again on notify()', async () => {
    const stream = openStream();
    try {
      const initial = JSON.parse(await stream.at(0)) as FederationGraph;
      assert.deepEqual(initial.apps.map((app) => app.name), ['host', 'wallet']);
      assert.equal(
        initial.apps.find((app) => app.name === 'wallet')?.status,
        undefined,
        'the connect frame reflects the statuses of that moment'
      );

      // Change state only AFTER the connection frame, so frame #1 can only
      // come from notify().
      statuses = { wallet: 'error' };
      await server.notify();
      const pushed = JSON.parse(await stream.at(1)) as FederationGraph;
      assert.equal(
        pushed.apps.find((app) => app.name === 'wallet')?.status,
        'error',
        'notify() must carry the status change'
      );
    } finally {
      stream.close();
      statuses = {};
    }
  });

  it('notify() without clients is a no-op that does not throw', async () => {
    await server.notify();
  });

  it('close() ends open streams and frees the port', async () => {
    const dedicated = createStudioServer({
      studioPort: 0,
      build: () => graph(),
      statuses: () => ({}),
    });
    startedServers.push(dedicated);
    const port = await dedicated.listen();
    const stream = openStream(port);
    await stream.at(0);
    await dedicated.close();

    // Rebinding the same port proves the listening socket is gone.
    await new Promise<void>((resolve, reject) => {
      const rebound = http.createServer();
      rebound.once('error', reject);
      rebound.listen(port, '127.0.0.1', () => rebound.close(() => resolve()));
    });
    stream.close();
    await dedicated.close(); // idempotent
  });
});

describe('Studio graph source over a real workspace', () => {
  const fs = createNodeProjectFs();
  const source = createWorkspaceGraphSource({
    workspaceDir: path.join(repoRoot, 'fixtures', 'workspace'),
    configReader: createWorkspaceConfigReader(fs),
    manifestSource: createFileManifestSource(fs),
  });

  it('loads the fixture workspace through the adapters', async () => {
    const graphPayload = await source.build({ host: 'ready' });
    assert.deepEqual(
      graphPayload.apps.map((app) => `${app.name}:${app.role}`),
      ['host:host', 'mini_auth:remote', 'mini_store:remote']
    );
    assert.deepEqual(graphPayload.findings, []);
  });

  it('reports an unusable workspace as a finding instead of throwing', async () => {
    const reasons: string[] = [];
    const broken = createWorkspaceGraphSource({
      workspaceDir: path.join(repoRoot, 'tests'),
      configReader: createWorkspaceConfigReader(fs),
      manifestSource: createFileManifestSource(fs),
      onWorkspaceError: (reason) => reasons.push(reason),
    });
    const payload = await broken.build({});
    assert.deepEqual(payload.apps, []);
    assert.equal(payload.findings[0]?.code, 'UNABLE_TO_ANSWER');
    assert.equal(reasons.length, 1);
  });
});
