// `repack-atlas init` through the spawned bin (T7, reduced scope).
//
// Runs on a temp copy of `fixtures/workspace` (never the real fixture): the
// plan must discover the three apps, `--dry-run` must not write, and the
// applied config must pass the core's own validator — init may never emit a
// config the doctor's loader would reject.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { validateFederationConfig } from '../../src/core/index.js';
import {
  copyTree,
  ensureBin,
  fixturesDir,
  parseJson,
  runBin,
} from './run-bin.js';

before(ensureBin);

const tmpRoots: string[] = [];

async function freshWorkspaceCopy(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-init-'));
  tmpRoots.push(root);
  const workspace = path.join(root, 'workspace');
  await copyTree(path.join(fixturesDir, 'workspace'), workspace);
  return workspace;
}

after(async () => {
  await Promise.all(
    tmpRoots.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

interface InitJson {
  tool: string;
  command: string;
  dryRun: boolean;
  written: boolean;
  apps: { dir: string; name: string; role: string; facts: string }[];
  config: unknown;
}

describe('init (spawned bin, reduced scope)', () => {
  it('--dry-run plans from a temp copy and writes nothing', async () => {
    const workspace = await freshWorkspaceCopy();
    const configPath = path.join(workspace, 'repack-federation.json');
    const beforeCopy = await readFile(configPath, 'utf-8');

    const result = await runBin(
      'init',
      '--workspace',
      workspace,
      '--dry-run',
      '--json'
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJson<InitJson>(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.written, false);
    assert.deepEqual(
      payload.apps.map((app) => app.dir).sort(),
      ['apps/host', 'apps/mini-auth', 'apps/mini-store']
    );
    // The fixture apps never ran the introspection plugin (no build step by
    // design), so facts fall back to directory names; the app named `host`
    // becomes the host, the rest are remotes.
    const byName = new Map(payload.apps.map((app) => [app.name, app]));
    assert.equal(byName.get('host')?.role, 'host');
    assert.equal(byName.get('mini-auth')?.role, 'remote');
    assert.equal(byName.get('mini-store')?.role, 'remote');
    for (const app of payload.apps) {
      assert.equal(app.facts, 'directory-name');
    }

    const afterCopy = await readFile(configPath, 'utf-8');
    assert.equal(afterCopy, beforeCopy, 'dry run must not touch the file');
  });

  it('apply writes a config that passes the core validator', async () => {
    const workspace = await freshWorkspaceCopy();
    const configPath = path.join(workspace, 'repack-federation.json');
    // init must also work when there is no config yet (fresh workspace).
    await rm(configPath);

    const result = await runBin('init', '--workspace', workspace, '--json');
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJson<InitJson>(result.stdout);
    assert.equal(payload.written, true);

    const written = JSON.parse(await readFile(configPath, 'utf-8')) as unknown;
    assert.deepEqual(validateFederationConfig(written), []);
    assert.deepEqual(written, payload.config, 'payload mirrors the file');
  });

  it('introspection facts upgrade names, ports and the host role', async () => {
    const workspace = await freshWorkspaceCopy();
    // Simulate apps that ran the opt-in introspection plugin once: the
    // host app renames itself, a remote declares its dev-server port.
    const facts = (name: string, extra: string): string =>
      JSON.stringify({
        schemaVersion: 1,
        name,
        exposes: [],
        remotes: {},
        shared: [],
        ...JSON.parse(extra),
      });
    await mkdir(path.join(workspace, 'apps', 'host', '.repack-atlas'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, 'apps', 'host', '.repack-atlas', 'introspection.json'),
      facts('SuperHost', '{"role":"host"}'),
      'utf-8'
    );
    await mkdir(path.join(workspace, 'apps', 'mini-auth', '.repack-atlas'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, 'apps', 'mini-auth', '.repack-atlas', 'introspection.json'),
      facts('mini_auth', '{"port":8082,"role":"remote"}'),
      'utf-8'
    );

    const result = await runBin('init', '--workspace', workspace, '--dry-run', '--json');
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJson<InitJson>(result.stdout);
    const byName = new Map(payload.apps.map((app) => [app.name, app]));
    assert.equal(byName.get('SuperHost')?.role, 'host');
    assert.equal(byName.get('SuperHost')?.facts, 'introspection');
    assert.equal(byName.get('mini_auth')?.role, 'remote');
    assert.equal(byName.get('mini_auth')?.facts, 'introspection');
    // The port from facts lands in the config's remote entry.
    const config = payload.config as {
      remotes: Record<string, { port?: number }>;
    };
    assert.equal(config.remotes['mini_auth']?.port, 8082);
  });

  it('a workspace without apps is exit 2', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-init-empty-'));
    tmpRoots.push(root);
    const result = await runBin('init', '--workspace', root);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no apps discovered/);
  });

  it('a nonexistent workspace is exit 2', async () => {
    const result = await runBin(
      'init',
      '--workspace',
      path.join(os.tmpdir(), 'definitely-not-here-atlas-init')
    );
    assert.equal(result.code, 2);
  });
});
