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
  warnings: string[];
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

describe('init: bounded discovery (spawned bin)', () => {
  async function ws(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-init-bound-'));
    tmpRoots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf-8');
    }
    return root;
  }
  const run = async (workspace: string): Promise<InitJson> => {
    const result = await runBin('init', '--workspace', workspace, '--dry-run', '--json');
    assert.equal(result.code, 0, result.stderr);
    return parseJson<InitJson>(result.stdout);
  };

  it('** does not descend below an app or into native/build dirs', async () => {
    const workspace = await ws({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/**"\n',
      'packages/host/rspack.config.js': '',
      'packages/host/ios/rspack.config.js': '',
      'packages/host/nested/rspack.config.js': '',
      'packages/group/build/rspack.config.js': '',
      'packages/group/dist/rspack.config.js': '',
      'packages/group/ios/rspack.config.js': '',
      'packages/group/android/rspack.config.js': '',
      'packages/group/Pods/rspack.config.js': '',
      'packages/group/remote/rspack.config.js': '',
    });
    const payload = await run(workspace);
    assert.deepEqual(
      payload.apps.map((app) => app.dir),
      ['packages/group/remote', 'packages/host']
    );
  });

  it('negation-only globs fall back to apps/*', async () => {
    const workspace = await ws({
      'pnpm-workspace.yaml': 'packages:\n  - "!apps/skip"\n',
      'apps/one/rspack.config.js': '',
    });
    const payload = await run(workspace);
    assert.deepEqual(payload.apps.map((app) => app.dir), ['apps/one']);
    const excluded = await ws({
      'pnpm-workspace.yaml': 'packages:\n  - "!apps/skip"\n',
      'apps/one/rspack.config.js': '',
      'apps/skip/rspack.config.js': '',
    });
    assert.deepEqual(
      (await run(excluded)).apps.map((app) => app.dir),
      ['apps/one']
    );
    // The same exclusions apply when the fallback scans the workspace root.
    const rootScan = await ws({
      'pnpm-workspace.yaml': 'packages:\n  - "!skip"\n',
      'one/rspack.config.js': '',
      'skip/rspack.config.js': '',
    });
    assert.deepEqual(
      (await run(rootScan)).apps.map((app) => app.dir),
      ['one']
    );
    const empty = await ws({ 'pnpm-workspace.yaml': 'packages:\n  - "!x"\n' });
    const result = await runBin('init', '--workspace', empty);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no apps discovered under the directory /);
  });

  it('apps sharing a basename get distinct names and manifests', async () => {
    const workspace = await ws({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*/*"\n',
      'packages/a/app/rspack.config.js': '',
      'packages/b/app/rspack.config.js': '',
      'packages/b/other/rspack.config.js': '',
    });
    const payload = await run(workspace);
    const names = payload.apps.map((app) => app.name);
    assert.deepEqual(names, ['packages-a-app', 'packages-b-app', 'other']);
    assert.equal(new Set(names).size, names.length);
    const config = payload.config as {
      host: { manifest: string };
      remotes: Record<string, { manifest: string }>;
    };
    const manifests = [
      config.host.manifest,
      ...Object.values(config.remotes).map((r) => r.manifest),
    ];
    assert.equal(new Set(manifests).size, 3);
    assert.deepEqual(validateFederationConfig(payload.config), []);
  });

  it('dashed names that collide get a numeric suffix', async () => {
    const workspace = await ws({
      'pnpm-workspace.yaml':
        'packages:\n  - "packages/*/*"\n  - "flat/*"\n  - "p/*/*/*"\n',
      // Dashed vs plain: `packages/x/app` dashes to the plain name of
      // `flat/packages-x-app`, which keeps it.
      'packages/x/app/rspack.config.js': '',
      'packages/y/app/rspack.config.js': '',
      'flat/packages-x-app/rspack.config.js': '',
      // Dashed vs dashed: both dash to `p-a-b-c-z`.
      'p/a/b-c/z/rspack.config.js': '',
      'p/a-b/c/z/rspack.config.js': '',
    });
    const payload = await run(workspace);
    const byDir = new Map(payload.apps.map((app) => [app.dir, app.name]));
    assert.equal(byDir.get('flat/packages-x-app'), 'packages-x-app');
    assert.equal(byDir.get('packages/x/app'), 'packages-x-app-2');
    assert.equal(byDir.get('packages/y/app'), 'packages-y-app');
    // Sorted dir order decides: `-` sorts before `/`.
    assert.equal(byDir.get('p/a-b/c/z'), 'p-a-b-c-z');
    assert.equal(byDir.get('p/a/b-c/z'), 'p-a-b-c-z-2');
    const names = payload.apps.map((app) => app.name);
    assert.equal(new Set(names).size, names.length);
    const config = payload.config as {
      host: { manifest: string };
      remotes: Record<string, { manifest: string }>;
    };
    const manifests = [
      config.host.manifest,
      ...Object.values(config.remotes).map((r) => r.manifest),
    ];
    assert.equal(new Set(manifests).size, payload.apps.length);
    assert.deepEqual(validateFederationConfig(payload.config), []);
  });

  it('warns when the ** depth cap truncated a walk', async () => {
    const deepDirs = Array.from({ length: 8 }, (_, i) => `d${i + 1}`).join('/');
    const workspace = await ws({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/**"\n',
      'packages/host/rspack.config.js': '',
      [`packages/${deepDirs}/app/rspack.config.js`]: '',
    });
    const payload = await run(workspace);
    assert.deepEqual(payload.apps.map((app) => app.dir), ['packages/host']);
    assert.equal(payload.warnings.length, 1);
    assert.match(payload.warnings[0]!, /"packages\/\*\*" stopped at depth 8/);
    const text = await runBin('init', '--workspace', workspace, '--dry-run');
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /warning: workspace glob "packages\/\*\*" stopped at depth 8/);

    const shallow = await ws({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/**"\n',
      'packages/host/rspack.config.js': '',
    });
    assert.deepEqual((await run(shallow)).warnings, []);
  });
});

describe('init: port validation and no derived command', () => {
  const baseFiles = {
    [`${WS}/pnpm-workspace.yaml`]: 'packages:\n  - apps/*\n',
    [`${WS}/apps/host/rspack.config.js`]: '',
    [`${WS}/apps/host/package.json`]: pkg('@x/host', { start: 'rspack start' }),
    [`${WS}/apps/auth/rspack.config.js`]: '',
    [`${WS}/apps/auth/package.json`]: pkg('@x/auth'),
  };

  it('never emits a command: dev builds the argv from root, and the config validates', async () => {
    const result = await buildInitPlan(
      WS,
      memoryFs(baseFiles),
      introspectorWith({})
    );
    assert.ok(result.ok);
    const json = JSON.parse(initPlanToJson(result.plan, false)) as {
      apps: { name: string; command?: string; notes: string[] }[];
      config: {
        host: { root?: string; command?: string };
        remotes: Record<string, { root?: string; command?: string }>;
      };
    };
    for (const app of json.apps) {
      assert.equal(app.command, undefined);
      assert.deepEqual(app.notes, []);
    }
    assert.equal(json.config.host.command, undefined);
    assert.equal(json.config.host.root, 'apps/host');
    assert.equal(json.config.remotes.auth?.command, undefined);
    assert.equal(json.config.remotes.auth?.root, 'apps/auth');
    assert.deepEqual(validateFederationConfig(result.plan.config), []);
    assert.doesNotMatch(formatInitPlan(result.plan, false), /command/);
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
});
