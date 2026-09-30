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
import {
  buildInitPlan,
  formatInitPlan,
  initPlanToJson,
} from '../../src/cli/init.js';
import {
  validateFederationConfig,
  type ConfigIntrospector,
  type ProjectFs,
} from '../../src/core/index.js';
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

  it('introspection facts keep the host port in the generated host entry', async () => {
    const workspace = await freshWorkspaceCopy();
    await mkdir(path.join(workspace, 'apps', 'host', '.repack-atlas'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, 'apps', 'host', '.repack-atlas', 'introspection.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'SuperHost',
        role: 'host',
        port: 8081,
        exposes: [],
        remotes: {},
        shared: [],
      }),
      'utf-8'
    );

    const result = await runBin('init', '--workspace', workspace, '--dry-run', '--json');
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJson<InitJson>(result.stdout);
    const config = payload.config as { host: { port?: number } };
    assert.equal(config.host.port, 8081);
    assert.deepEqual(validateFederationConfig(payload.config), []);
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

// In-memory workspace: `files` maps absolute paths to contents; directories
// are implied by their children.
function memoryFs(files: Record<string, string>): ProjectFs {
  const paths = Object.keys(files);
  const isDir = (p: string): boolean =>
    paths.some((file) => file.startsWith(`${p}/`));
  return {
    stat: async (p) =>
      p in files
        ? { isDirectory: false, sizeBytes: files[p]!.length }
        : isDir(p)
          ? { isDirectory: true, sizeBytes: 0 }
          : null,
    exists: async (p) => p in files || isDir(p),
    readFile: async (p) => files[p] ?? null,
    readdir: async (p) => [
      ...new Set(
        paths
          .filter((file) => file.startsWith(`${p}/`))
          .map((file) => file.slice(p.length + 1).split('/')[0]!)
      ),
    ],
    walk: async () => [],
  };
}

function introspectorWith(
  ports: Record<string, number>
): ConfigIntrospector {
  return {
    read: async (appRoot) => {
      const port = ports[path.basename(appRoot)];
      if (port === undefined) return { status: 'missing' } as never;
      return {
        status: 'ok',
        facts: {
          schemaVersion: 1,
          name: path.basename(appRoot),
          exposes: [],
          remotes: {},
          shared: [],
          port,
        },
      } as never;
    },
  };
}

const WS = '/ws';
const pkg = (name: string, scripts?: Record<string, string>): string =>
  JSON.stringify({ name, ...(scripts ? { scripts } : {}) });

describe('init: workspace-glob discovery (spawned bin)', () => {
  async function discoveryCopy(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-init-disc-'));
    tmpRoots.push(root);
    const workspace = path.join(root, 'workspace');
    await copyTree(path.join(fixturesDir, 'discovery-packages'), workspace);
    return workspace;
  }

  async function discover(workspace: string): Promise<InitJson> {
    const result = await runBin('init', '--workspace', workspace, '--dry-run', '--json');
    assert.equal(result.code, 0, result.stderr);
    return parseJson<InitJson>(result.stdout);
  }

  it('discovers apps under packages/* and skips non-app packages', async () => {
    const payload = await discover(await discoveryCopy());
    assert.deepEqual(
      payload.apps.map((app) => app.dir),
      ['packages/feature-auth', 'packages/host']
    );
    assert.equal(payload.apps.find((app) => app.name === 'host')?.role, 'host');
    assert.deepEqual(validateFederationConfig(payload.config), []);
  });

  it('reads package.json workspaces (array) and honors negation', async () => {
    const workspace = await discoveryCopy();
    await rm(path.join(workspace, 'pnpm-workspace.yaml'));
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['packages/*', '!packages/host'] }),
      'utf-8'
    );
    const payload = await discover(workspace);
    assert.deepEqual(
      payload.apps.map((app) => app.dir),
      ['packages/feature-auth']
    );
  });

  it('reads package.json workspaces ({ packages }) with ** and skips node_modules', async () => {
    const workspace = await discoveryCopy();
    await rm(path.join(workspace, 'pnpm-workspace.yaml'));
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['packages/**'] } }),
      'utf-8'
    );
    const nested = path.join(workspace, 'packages', 'ui-kit', 'node_modules', 'dep');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'webpack.config.js'), '', 'utf-8');
    const deep = path.join(workspace, 'packages', 'group', 'deep-app');
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, 'webpack.config.js'), '', 'utf-8');
    const payload = await discover(workspace);
    assert.deepEqual(
      payload.apps.map((app) => app.dir),
      ['packages/feature-auth', 'packages/group/deep-app', 'packages/host']
    );
  });
});

describe('init: derived commands and port validation', () => {
  const baseFiles = {
    [`${WS}/pnpm-workspace.yaml`]: 'packages:\n  - apps/*\n',
    [`${WS}/apps/host/rspack.config.js`]: '',
    [`${WS}/apps/host/package.json`]: pkg('@x/host', { start: 'rspack start' }),
    [`${WS}/apps/auth/rspack.config.js`]: '',
    [`${WS}/apps/auth/package.json`]: pkg('@x/auth'),
  };

  it('derives a command where safe and the config validates', async () => {
    const result = await buildInitPlan(
      WS,
      memoryFs(baseFiles),
      introspectorWith({})
    );
    assert.ok(result.ok);
    const json = JSON.parse(initPlanToJson(result.plan, false)) as {
      apps: { name: string; command?: string; notes: string[] }[];
      config: { host: { command?: string } };
    };
    const byName = new Map(json.apps.map((app) => [app.name, app]));
    assert.equal(byName.get('host')?.command, 'pnpm --filter @x/host start');
    assert.equal(json.config.host.command, 'pnpm --filter @x/host start');
    // Missing start script: no command, and the reason is reported.
    assert.equal(byName.get('auth')?.command, undefined);
    assert.match(byName.get('auth')!.notes.join(' '), /no scripts\.start/);
    assert.deepEqual(validateFederationConfig(result.plan.config), []);
    assert.match(formatInitPlan(result.plan, false), /note: no command/);
  });

  it('picks the package manager from the workspace root', async () => {
    const files = { ...baseFiles };
    delete (files as Record<string, string>)[`${WS}/pnpm-workspace.yaml`];
    const commandFor = async (lock: string): Promise<string | undefined> => {
      const result = await buildInitPlan(
        WS,
        memoryFs({ ...files, [`${WS}/${lock}`]: '' }),
        introspectorWith({})
      );
      assert.ok(result.ok);
      return result.plan.host?.command;
    };
    assert.equal(await commandFor('yarn.lock'), 'yarn workspace @x/host start');
    assert.equal(
      await commandFor('package-lock.json'),
      'npm --workspace @x/host run start'
    );
    const none = await buildInitPlan(
      WS,
      memoryFs(files),
      introspectorWith({})
    );
    assert.ok(none.ok);
    assert.equal(none.plan.host?.command, undefined);
    assert.match(none.plan.host!.notes.join(' '), /package manager not detected/);
  });

  it('drops out-of-range introspected ports and reports them', async () => {
    const result = await buildInitPlan(
      WS,
      memoryFs(baseFiles),
      introspectorWith({ host: 0, auth: 80.5 })
    );
    assert.ok(result.ok);
    for (const app of result.plan.apps) {
      assert.equal(app.port, undefined);
      assert.match(app.notes.join(' '), /dropped introspected port/);
    }
    assert.deepEqual(validateFederationConfig(result.plan.config), []);
    const text = formatInitPlan(result.plan, false);
    assert.match(text, /dropped introspected port 0/);
    assert.match(text, /dropped introspected port 80\.5/);
    assert.match(initPlanToJson(result.plan, false), /dropped introspected port 80\.5/);
  });

  it('keeps a valid introspected port', async () => {
    const result = await buildInitPlan(
      WS,
      memoryFs(baseFiles),
      introspectorWith({ host: 8081 })
    );
    assert.ok(result.ok);
    assert.equal(result.plan.host?.port, 8081);
  });

  describe('command derivation branches', () => {
    const planFor = async (
      host: { package?: string | undefined },
      extra: Record<string, string> = {}
    ) => {
      const files: Record<string, string> = {
        [`${WS}/pnpm-lock.yaml`]: '',
        [`${WS}/apps/host/rspack.config.js`]: '',
        ...extra,
      };
      if (host.package !== undefined) {
        files[`${WS}/apps/host/package.json`] = host.package;
      }
      const result = await buildInitPlan(WS, memoryFs(files), introspectorWith({}));
      assert.ok(result.ok);
      return result.plan.host!;
    };
    const valid = pkg('@x/host', { start: 'go' });

    it('omits with a note: no package.json, invalid JSON, no or empty name', async () => {
      const cases: [string | undefined, RegExp][] = [
        [undefined, /no package\.json/],
        ['{nope', /not valid JSON/],
        [JSON.stringify({ scripts: { start: 'go' } }), /has no name/],
        [pkg('', { start: 'go' }), /has no name/],
      ];
      for (const [content, note] of cases) {
        const host = await planFor({ package: content });
        assert.equal(host.command, undefined);
        assert.match(host.notes.join(' '), note);
      }
    });

    it('omits the command for a name that is not a valid npm name', async () => {
      for (const name of ['bad name; rm -rf', 'Upper', '$(id)', '.hidden', '_x', 'a'.repeat(215)]) {
        const host = await planFor({ package: pkg(name, { start: 'go' }) });
        assert.equal(host.command, undefined, name);
        assert.match(host.notes.join(' '), /not a valid npm package name/);
      }
      const ok = await planFor({ package: pkg('plain-name_1.x', { start: 'go' }) });
      assert.equal(ok.command, 'pnpm --filter plain-name_1.x start');
    });

    it('detects pnpm from pnpm-lock.yaml alone', async () => {
      const host = await planFor({ package: valid });
      assert.equal(host.command, 'pnpm --filter @x/host start');
    });

    it('prefers pnpm, then yarn, then npm when several lockfiles exist', async () => {
      const all = await planFor(
        { package: valid },
        { [`${WS}/yarn.lock`]: '', [`${WS}/package-lock.json`]: '' }
      );
      assert.equal(all.command, 'pnpm --filter @x/host start');
      const files = {
        [`${WS}/apps/host/rspack.config.js`]: '',
        [`${WS}/apps/host/package.json`]: valid,
        [`${WS}/yarn.lock`]: '',
        [`${WS}/package-lock.json`]: '',
      };
      const result = await buildInitPlan(WS, memoryFs(files), introspectorWith({}));
      assert.ok(result.ok);
      assert.equal(result.plan.host?.command, 'yarn workspace @x/host start');
    });
  });
});
