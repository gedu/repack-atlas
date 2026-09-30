// `repack-atlas init` — reduced scope (T7).
//
// Scope note (recorded as a deferral): the full upstream init from
// callstack/repack #1466 generates a single-source shared config from
// installed versions and can evaluate rspack configs (`extractShared`,
// feature scan). Per the T0 decision those need in-process config loading,
// which Atlas keeps out of scope; this command only discovers apps and
// writes/repairs the `repack-federation.json` skeleton. Upstream's
// `--dry-run` semantics (plan without writing) are honored for this
// reduced scope.
//
// Discovery rules (deterministic, no config evaluation):
//   - apps live in `<workspace>/apps/*` (the fixture/showcase layout); if
//     that directory does not exist, the workspace's own subdirectories are
//     scanned;
//   - an app counts when it contains a `rspack.config.*` file;
//   - federation facts (federation name, port, role) come from the app's
//     `.repack-atlas/introspection.json` when the opt-in plugin has written
//     it; otherwise the app dir name is the federation name;
//   - a `command` is derived per app only when it is safe: the app has a
//     package.json with a `name` and a `scripts.start`, and the workspace
//     root identifies the package manager (`pnpm-lock.yaml` or
//     `pnpm-workspace.yaml` -> pnpm, `yarn.lock` -> yarn, `package-lock.json`
//     -> npm); otherwise the command is omitted and the reason is reported;
//   - an introspected port outside the config rule (integer 1..65535) is
//     dropped and reported;
//   - the host is the discovered app whose facts say `role: "host"`, else
//     the one named `host`, else the first app in sorted order;
//   - manifest refs point at `<workspace>/manifests/<app dir>.json` — the
//     checked-in-manifests convention the fixtures and the showcase use.

import path from 'node:path';
import {
  FEDERATION_CONFIG_FILENAME,
  isValidPort,
  validateFederationConfig,
  type ConfigIntrospector,
  type FederationConfig,
  type ProjectFs,
} from '../core/index.js';

/** Config filename + relative manifest refs produced by a plan. */
export interface InitAppPlan {
  /** Workspace-relative app dir, e.g. `apps/host`. */
  dir: string;
  /** Federation name from introspection facts, else the app dir name. */
  name: string;
  role: 'host' | 'remote';
  manifest: string;
  port?: number;
  /** Derived start command; absent when it could not be derived safely. */
  command?: string;
  /** Why a command or port was omitted; empty when nothing was dropped. */
  notes: string[];
  facts: 'introspection' | 'directory-name';
}

export interface InitPlan {
  workspace: string;
  apps: InitAppPlan[];
  host?: InitAppPlan;
  configPath: string;
  /** True when a config already exists at configPath. */
  existing: boolean;
  /** The config document a write would produce. */
  config: FederationConfig;
}

export type InitPlanResult =
  | { ok: true; plan: InitPlan }
  | { ok: false; reason: string };

const RSPACK_CONFIG_PREFIX = 'rspack.config.';

type PackageManager = 'pnpm' | 'yarn' | 'npm';

async function detectPackageManager(
  workspaceDir: string,
  fs: ProjectFs
): Promise<PackageManager | undefined> {
  const has = (name: string): Promise<boolean> =>
    fs.exists(path.join(workspaceDir, name));
  if ((await has('pnpm-lock.yaml')) || (await has('pnpm-workspace.yaml'))) {
    return 'pnpm';
  }
  if (await has('yarn.lock')) return 'yarn';
  if (await has('package-lock.json')) return 'npm';
  return undefined;
}

function startCommand(manager: PackageManager, name: string): string {
  if (manager === 'pnpm') return `pnpm --filter ${name} start`;
  if (manager === 'yarn') return `yarn workspace ${name} start`;
  return `npm --workspace ${name} run start`;
}

/** Derive the start command for one app, or explain why it cannot be. */
async function deriveCommand(
  appDir: string,
  manager: PackageManager | undefined,
  fs: ProjectFs
): Promise<{ command?: string; note?: string }> {
  const raw = await fs.readFile(path.join(appDir, 'package.json'));
  if (raw === null) return { note: 'no command: no package.json' };
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { note: 'no command: package.json is not valid JSON' };
  }
  const record =
    typeof pkg === 'object' && pkg !== null
      ? (pkg as { name?: unknown; scripts?: unknown })
      : {};
  if (typeof record.name !== 'string' || record.name === '') {
    return { note: 'no command: package.json has no name' };
  }
  const scripts = record.scripts;
  const hasStart =
    typeof scripts === 'object' &&
    scripts !== null &&
    typeof (scripts as { start?: unknown }).start === 'string';
  if (!hasStart) return { note: 'no command: package.json has no scripts.start' };
  if (manager === undefined) {
    return {
      note: 'no command: package manager not detected (no pnpm/yarn/npm lockfile or pnpm-workspace.yaml)',
    };
  }
  return { command: startCommand(manager, record.name) };
}

function isHostishName(name: string): boolean {
  return name.toLowerCase() === 'host' || name.toLowerCase().endsWith('host');
}

/**
 * Discover apps and build the config plan. Never throws; a workspace with
 * no discoverable apps is a `reason`, not an exception.
 */
export async function buildInitPlan(
  workspace: string,
  fs: ProjectFs,
  introspector: ConfigIntrospector
): Promise<InitPlanResult> {
  const workspaceDir = path.resolve(workspace);
  const workspaceStat = await fs.stat(workspaceDir);
  if (workspaceStat === null || !workspaceStat.isDirectory) {
    return { ok: false, reason: `workspace does not exist: ${workspaceDir}` };
  }

  const appsRoot = path.join(workspaceDir, 'apps');
  const appsStat = await fs.stat(appsRoot);
  const scanDir = appsStat !== null && appsStat.isDirectory ? appsRoot : workspaceDir;
  const prefix = scanDir === appsRoot ? 'apps/' : '';

  const entryNames = (await fs.readdir(scanDir)).sort();
  const discovered: { dir: string; dirName: string }[] = [];
  for (const entryName of entryNames) {
    const appDir = path.join(scanDir, entryName);
    const stat = await fs.stat(appDir);
    if (stat === null || !stat.isDirectory) continue;
    // Skip the scan dir itself when the workspace root is scanned, plus
    // obvious non-app noise.
    if (prefix === '' && (entryName === 'apps' || entryName.startsWith('.'))) {
      continue;
    }
    const entries = await fs.readdir(appDir);
    const hasRspackConfig = entries.some((name) =>
      name.startsWith(RSPACK_CONFIG_PREFIX)
    );
    if (!hasRspackConfig) continue;
    discovered.push({ dir: `${prefix}${entryName}`, dirName: entryName });
  }

  if (discovered.length === 0) {
    return {
      ok: false,
      reason:
        `no apps discovered under ${scanDir} ` +
        '(an app is a directory containing a rspack.config.* file)',
    };
  }

  const manager = await detectPackageManager(workspaceDir, fs);
  const apps: InitAppPlan[] = [];
  for (const app of discovered) {
    const appRoot = path.join(workspaceDir, app.dir);
    const factsResult = await introspector.read(appRoot);
    const facts = factsResult.status === 'ok' ? factsResult.facts : undefined;
    const notes: string[] = [];
    let port: number | undefined;
    if (facts?.port !== undefined) {
      if (isValidPort(facts.port)) {
        port = facts.port;
      } else {
        notes.push(
          `dropped introspected port ${facts.port}: must be an integer between 1 and 65535`
        );
      }
    }
    const derived = await deriveCommand(appRoot, manager, fs);
    if (derived.note !== undefined) notes.push(derived.note);
    apps.push({
      dir: app.dir,
      name: facts?.name ?? app.dirName,
      role: facts?.role ?? 'remote',
      manifest: path.join('manifests', `${app.dirName}.json`),
      ...(port !== undefined ? { port } : {}),
      ...(derived.command !== undefined ? { command: derived.command } : {}),
      notes,
      facts: facts ? 'introspection' : 'directory-name',
    });
  }

  const host =
    apps.find((app) => app.role === 'host') ??
    apps.find((app) => isHostishName(app.name)) ??
    apps[0]!;
  host.role = 'host';

  const config: FederationConfig = {
    host: {
      manifest: host.manifest,
      root: host.dir,
      ...(host.port !== undefined ? { port: host.port } : {}),
      ...(host.command !== undefined ? { command: host.command } : {}),
    },
    remotes: {},
  };
  for (const app of apps) {
    if (app === host) continue;
    config.remotes[app.name] = {
      manifest: app.manifest,
      root: app.dir,
      ...(app.port !== undefined ? { port: app.port } : {}),
      ...(app.command !== undefined ? { command: app.command } : {}),
    };
  }

  const configPath = path.join(workspaceDir, FEDERATION_CONFIG_FILENAME);
  return {
    ok: true,
    plan: {
      workspace: workspaceDir,
      apps,
      host,
      configPath,
      existing: await fs.exists(configPath),
      config,
    },
  };
}

/** Serialize the plan for `--json`: dry-run and applied share this shape. */
export function initPlanToJson(plan: InitPlan, applied: boolean): string {
  return JSON.stringify(
    {
      tool: 'repack-atlas',
      command: 'init',
      dryRun: !applied,
      workspace: plan.workspace,
      configPath: plan.configPath,
      existing: plan.existing,
      written: applied,
      apps: plan.apps.map((app) => ({
        dir: app.dir,
        name: app.name,
        role: app.role,
        manifest: app.manifest,
        facts: app.facts,
        ...(app.port !== undefined ? { port: app.port } : {}),
        ...(app.command !== undefined ? { command: app.command } : {}),
        notes: app.notes,
      })),
      config: plan.config,
    },
    null,
    2
  );
}

/** Human-readable plan text. */
export function formatInitPlan(plan: InitPlan, applied: boolean): string {
  const lines = [
    `${applied ? 'Wrote' : 'Plan for'} ${plan.configPath}` +
      (plan.existing ? ' (repairs an existing file)' : ''),
    '',
    `apps (${plan.apps.length}):`,
  ];
  for (const app of plan.apps) {
    const notes = [app.role, `facts: ${app.facts}`];
    if (app.port !== undefined) notes.push(`port ${app.port}`);
    lines.push(`  ${app.dir}  ${app.name}  (${notes.join(', ')})`);
    if (app.command !== undefined) lines.push(`    command: ${app.command}`);
    for (const note of app.notes) lines.push(`    note: ${note}`);
  }
  if (!applied) {
    lines.push('', 'dry run: nothing was written.');
  }
  return lines.join('\n');
}

/**
 * Write the planned config. Validates the document with the core validator
 * before touching the disk — init must never emit a config the doctor's own
 * loader would reject.
 */
export async function writeInitConfig(
  plan: InitPlan,
  writeFile: (filePath: string, content: string) => Promise<void>
): Promise<void> {
  const reasons = validateFederationConfig(plan.config);
  if (reasons.length > 0) {
    throw new Error(
      `refusing to write an invalid config: ${reasons.join('; ')}`
    );
  }
  await writeFile(plan.configPath, `${JSON.stringify(plan.config, null, 2)}\n`);
}
