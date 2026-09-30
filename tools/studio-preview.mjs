#!/usr/bin/env node
// Dev-only Studio preview (T8): boots the read-only Studio over a workspace
// whose manifests are plain files, with every app status `idle`. It exists so
// humans and the Playwright suite have a stable URL without the T9 runner.
//
// Not part of the published package: it lives in `tools/`, is excluded from the
// tsconfig build, and imports the compiled output like any consumer would.
// It writes nothing — the Studio is read-only forever (AGENTS.md rule 5).
//
//   node tools/studio-preview.mjs --workspace fixtures/workspace --port 8099

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgv(argv) {
  const options = { workspace: path.join(repoRoot, 'fixtures', 'workspace'), port: 8099, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace' || arg === '-w') options.workspace = path.resolve(repoRoot, argv[++i]);
    else if (arg === '--port' || arg === '-p') options.port = Number(argv[++i]);
    else if (arg === '--host') options.host = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      process.stderr.write(`studio-preview: unknown argument ${arg}\n`);
      process.exitCode = 2;
      return options;
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    process.stderr.write('studio-preview: --port must be a TCP port number\n');
    process.exitCode = 2;
    options.help = true;
  }
  return options;
}

const HELP = `usage: node tools/studio-preview.mjs [--workspace <dir>] [--port <n>] [--host <addr>]

Serves the read-only Federation Studio over a workspace with file manifests.
Defaults: --workspace fixtures/workspace --port 8099 --host 127.0.0.1`;

async function main() {
  const options = parseArgv(process.argv.slice(2));
  if (process.exitCode === 2) return process.exitCode;
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const dist = (...subpath) => path.join(repoRoot, 'dist', ...subpath);
  let studio;
  let adapters;
  try {
    studio = await import(pathToFileURL(dist('studio', 'index.js')).href);
    adapters = await import(pathToFileURL(dist('adapters', 'index.js')).href);
  } catch (error) {
    process.stderr.write(
      `studio-preview: cannot load ${dist('studio/index.js')} (${error.message}). Run "pnpm build" first.\n`
    );
    return 2;
  }

  const fs = adapters.createNodeProjectFs();
  const graphSource = studio.createWorkspaceGraphSource({
    workspaceDir: options.workspace,
    configReader: adapters.createWorkspaceConfigReader(fs),
    manifestSource: adapters.createManifestSource(fs),
    statuses: () => ({}), // static preview: nothing is running
    onWorkspaceError: (reason) => process.stderr.write(`studio-preview: ${reason}\n`),
  });

  const server = studio.createStudioServer({
    ...graphSource,
    host: options.host,
    studioPort: options.port,
    onError: (error, context) =>
      process.stderr.write(`studio-preview: ${context}: ${String(error)}\n`),
  });

  await server.listen();
  process.stdout.write(`Federation Studio (preview, read-only): ${server.url()}\nworkspace: ${options.workspace}\n`);

  await new Promise((resolve) => {
    const stop = () => resolve();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await server.close();
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`studio-preview: unexpected failure: ${String(error)}\n`);
    process.exitCode = 2;
  }
);
