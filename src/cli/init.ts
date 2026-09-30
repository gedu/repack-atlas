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
//   - the host is the discovered app whose facts say `role: "host"`, else
//     the one named `host`, else the first app in sorted order;
//   - manifest refs point at `<workspace>/manifests/<app dir>.json` — the
//     checked-in-manifests convention the fixtures and the showcase use.

import path from 'node:path';
import {
  FEDERATION_CONFIG_FILENAME,
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

  const apps: InitAppPlan[] = [];
  for (const app of discovered) {
    const factsResult = await introspector.read(path.join(workspaceDir, app.dir));
    const facts = factsResult.status === 'ok' ? factsResult.facts : undefined;
    apps.push({
      dir: app.dir,
      name: facts?.name ?? app.dirName,
      role: facts?.role ?? 'remote',
      manifest: path.join('manifests', `${app.dirName}.json`),
      ...(facts?.port !== undefined ? { port: facts.port } : {}),
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
    },
    remotes: {},
  };
  for (const app of apps) {
    if (app === host) continue;
    config.remotes[app.name] = {
      manifest: app.manifest,
      root: app.dir,
      ...(app.port !== undefined ? { port: app.port } : {}),
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
