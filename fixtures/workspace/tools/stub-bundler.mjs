#!/usr/bin/env node
// Stub dev-server for the fixture workspace (T9 runner tests).
//
// Fixtures carry no real rspack build (budget rule: seconds, no install),
// so `repack-atlas dev` runs THIS as each app's `command`: it binds the
// port the runner assigned (`ATLAS_APP_PORT`), serves the app's checked-in
// manifest at the Re.Pack asset route `/repack-federation-manifest.json`,
// prints `ready` after a fixed small delay, and exits on SIGINT/SIGTERM.
// It is deliberately tiny and deterministic — the runner test suite times
// readiness against it.
//
// Resolution comes from the runner's env contract (see src/runner/supervisor
// .ts): ATLAS_APP_PORT is mandatory; ATLAS_APP_MANIFEST points at the
// checked-in manifest JSON. Invoked directly (outside the runner) both
// have documented fallbacks so `node tools/stub-bundler.mjs` still works.

import http from 'node:http';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const port = Number(process.env.ATLAS_APP_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write('stub-bundler: ATLAS_APP_PORT must be a TCP port\n');
  process.exit(2);
}
const appName = process.env.ATLAS_APP_NAME ?? 'stub';
const manifestPath =
  process.env.ATLAS_APP_MANIFEST ||
  // Direct-run fallback: the host manifest of this workspace.
  path.join(workspaceDir, 'manifests', 'host.json');
const readyDelayMs = Number(process.env.ATLAS_READY_DELAY_MS ?? 50);

const server = http.createServer((request, response) => {
  const route = (request.url ?? '/').split('?')[0];
  if (route === '/repack-federation-manifest.json') {
    readFile(manifestPath)
      .then((body) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(500);
        response.end('{}');
      });
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(`${appName} stub bundler\n`);
});

server.listen(port, '127.0.0.1', () => {
  // The `ready` line is what humans see; the runner's readiness signal is
  // the port itself (documented in src/runner/supervisor.ts).
  setTimeout(() => process.stdout.write('ready\n'), readyDelayMs);
});

function stop(signal) {
  server.close(() => process.exit(0));
  // Never outlive the signal, even with keep-alive sockets open.
  setTimeout(() => process.exit(0), 200).unref();
  void signal;
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
