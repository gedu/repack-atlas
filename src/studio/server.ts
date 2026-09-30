// The Studio HTTP server (docs/PRD.md §7.2/§7.3).
//
// READ-ONLY, FOREVER. The route table below is the entire public surface:
//
//   GET /             -> the self-contained page (`./page.js`)
//   GET /api/graph    -> the federation graph, statuses injected
//   GET /api/events   -> SSE: the graph on every `notify()`
//
// There is no other route and there must never be one: no write endpoint, no
// config editing, no file serving from disk. That is an AGENTS.md hard rule
// (rule 5), not a phase-1 shortcut, so this file (a) registers exactly three
// routes, (b) answers every non-GET with 405 + `Allow: GET, HEAD`, and (c)
// answers every unknown path with 404 without ever touching the filesystem.
// `tests/studio/server.test.ts` asserts all of it, including a path-traversal
// attempt, so a future "just add a small write endpoint" PR fails a test.
//
// Binding is 127.0.0.1 only. Manifest content is untrusted; the page renders it
// as text, the API only ever returns data the caller already asked for, and no
// CORS headers are set, so a random page in the browser cannot read this API.

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { AppStatusMap, FederationGraph } from '../core/index.js';
import { studioPageHtml } from './page.js';

/** Default Studio port; the first free port at or above it is used. */
export const DEFAULT_STUDIO_PORT = 8099;

/**
 * Supplies the graph payload. The caller (T9 runner, or the dev preview tool)
 * owns manifest loading and doctor runs; the server only serializes and pushes.
 * `statuses` is asked for at request time so `/api/graph` is always current.
 */
export interface StudioGraphSource {
  /** Fresh graph for this workspace. Must not throw. */
  build(statuses: AppStatusMap): Promise<FederationGraph> | FederationGraph;
  /** Live dev-server statuses, keyed by graph app name. */
  statuses(): AppStatusMap;
}

export interface StudioServerOptions {
  /** Bind address. Pinned to the loopback default; `::1` is the only sane alternative. */
  host?: string;
  /** `0` (default) asks the OS for an ephemeral port. */
  studioPort?: number;
  graphSource: StudioGraphSource;
  /** Called for every unhandled failure; the server never crashes the host. */
  onError?: (error: unknown, context: string) => void;
}

export interface StudioServer {
  /** Port the server is listening on (meaningful after `listen()`). */
  address(): AddressInfo | null;
  /** Resolved URL of the page, for logs and `{event:'studio', url}` events. */
  url(): string | null;
  /** Start listening; resolves with the actual port. */
  listen(): Promise<number>;
  /**
   * Push the current graph to every SSE client. Called by the runner after a
   * rebuild or a status change; harmless (and cheap) when nobody is connected.
   */
  notify(): Promise<void>;
  /** Close the server and every open event stream. Idempotent. */
  close(): Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;
/** The page and the API are same-origin only; no `access-control-allow-origin`. */
const SHARED_HEADERS = { 'cache-control': 'no-store' } as const;

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...SHARED_HEADERS,
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** Route keys are the pathname only (query strings are ignored on purpose). */
function routeOf(request: http.IncomingMessage): string {
  const raw = request.url ?? '/';
  const queryIndex = raw.indexOf('?');
  return queryIndex === -1 ? raw : raw.slice(0, queryIndex);
}

/**
 * Serve the Studio over `127.0.0.1`. Composed by the runner (T9) and by
 * `tools/studio-preview.mjs`; owns no data of its own.
 */
export function createStudioServer(
  options: StudioGraphSource & Omit<StudioServerOptions, 'graphSource'>
): StudioServer {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.studioPort ?? 0;
  const report = options.onError ?? (() => {});

  /** One SSE client. `id` keeps the per-client retry/removal unambiguous. */
  interface EventClient {
    response: http.ServerResponse;
    close: () => void;
  }
  const clients = new Set<EventClient>();
  let server: http.Server | null = null;

  function handleEvents(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Chunked by construction: no content-length on a stream that never ends.
      'x-accel-buffering': 'no',
    });
    response.write('retry: 1000\n\n');

    const client: EventClient = {
      response,
      close: () => {
        clients.delete(client);
        response.end();
      },
    };
    clients.add(client);

    // Detach the stream from the request lifecycle: an aborted request must not
    // leave a half-open client in the set.
    request.on('close', () => {
      clients.delete(client);
    });
    response.on('error', () => {
      clients.delete(client);
    });

    // Send the current graph immediately, so a reconnecting page repaints
    // without waiting for the next rebuild.
    void pushGraph();
  }

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const path = routeOf(request);

    // Non-GET anywhere: 405 with the honest Allow header. A write is not
    // "temporarily unsupported", it is refused, so no body invites a retry.
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, {
        ...SHARED_HEADERS,
        ...JSON_HEADERS,
        allow: 'GET, HEAD',
      });
      response.end(
        JSON.stringify({
          error: 'method-not-allowed',
          message: 'The Studio is read-only: only GET is supported.',
        })
      );
      return;
    }

    if (path === '/api/events') {
      handleEvents(request, response);
      return;
    }

    if (path === '/api/graph') {
      try {
        const graph = await options.build(options.statuses());
        sendJson(response, 200, graph);
      } catch (error) {
        report(error, 'api/graph');
        sendJson(response, 500, { error: 'graph-unavailable', message: 'The graph could not be built.' });
      }
      return;
    }

    if (path === '/') {
      const page = studioPageHtml();
      response.writeHead(200, {
        ...SHARED_HEADERS,
        ...HTML_HEADERS,
        'content-length': Buffer.byteLength(page),
      });
      response.end(method === 'HEAD' ? undefined : page);
      return;
    }

    // Anything else — including `/../`, `/../../etc/passwd`, `/api/graph/extra`
    // — is a 404. There is no filesystem handler to traverse toward.
    sendJson(response, 404, { error: 'not-found', message: `No Studio route for ${method} ${path}` });
  }

  async function pushGraph(): Promise<void> {
    if (clients.size === 0) return;
    let frame: string;
    try {
      const graph = await options.build(options.statuses());
      frame = `event: graph\ndata: ${JSON.stringify(graph)}\n\n`;
    } catch (error) {
      report(error, 'sse/graph');
      return;
    }
    for (const client of [...clients]) {
      try {
        client.response.write(frame);
      } catch (error) {
        // A dead socket must not stop the other clients from updating.
        report(error, 'sse/write');
        clients.delete(client);
      }
    }
  }

  return {
    address: () => (server ? (server.address() as AddressInfo | null) : null),
    url() {
      const address = this.address();
      return address ? `http://${host}:${address.port}/` : null;
    },
    listen() {
      if (server) return Promise.resolve((server.address() as AddressInfo).port);
      const instance = http.createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          report(error, 'request');
          if (!response.headersSent) {
            sendJson(response, 500, { error: 'internal', message: 'Studio failed.' });
          } else {
            response.end();
          }
        });
      });
      // Loopback only, no keep-alive lingering that would hold `close()` open.
      instance.keepAliveTimeout = 1_000;
      server = instance;
      return new Promise<number>((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(requestedPort, host, () => {
          instance.off('error', reject);
          instance.on('error', (error) => report(error, 'server'));
          resolve((instance.address() as AddressInfo).port);
        });
      });
    },
    notify: pushGraph,
    close() {
      for (const client of [...clients]) {
        try {
          client.close();
        } catch (error) {
          report(error, 'sse/close');
        }
      }
      clients.clear();
      const instance = server;
      server = null;
      if (!instance) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        instance.closeAllConnections?.();
        instance.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * First free TCP port at or above `from`, probed on the loopback interface.
 * Owns a socket only long enough to learn the answer (PRD §7.2 default port).
 */
export function firstFreeFrom(
  from: number = DEFAULT_STUDIO_PORT,
  host = '127.0.0.1'
): Promise<number> {
  if (from > 65_535) {
    return Promise.reject(new Error(`no free port at or above ${from}`));
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => {
      // Busy (or unusable): walk forward. The recursion is bounded by the
      // 65535 guard above.
      firstFreeFrom(from + 1, host).then(resolve, reject);
    });
    probe.listen(from, host, () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}
