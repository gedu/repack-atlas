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
//   - candidate dirs come from the workspace globs: the `packages:` list of
//     `pnpm-workspace.yaml` (minimal line parser, that one list only) plus
//     the `workspaces` field of `package.json` (an array or `{ packages }`).
//     Supported patterns: `dir/*` (one level), `dir/**` (any depth, zero or
//     more levels), partial-segment wildcards such as `app-*`, and literal
//     paths. `node_modules` and dot dirs are never expanded. A `!pattern`
//     is an exclusion: any candidate it matches is removed, whatever the
//     order. No other glob syntax (`?`, `{a,b}`, `[x]`) is interpreted;
//   - `**` is bounded: it stops below a dir that already is an app, skips
//     `ios`, `android`, `build`, `dist` and `Pods`, and is capped at depth 8
//     (ProjectFs cannot identify symlinks, so the cap guards link cycles);
//   - when there is no positive workspace glob (none declared, or only `!`
//     exclusions), apps live in
//     `<workspace>/apps/*` (the fixture layout); if that directory does not
//     exist, the workspace's own subdirectories are scanned;
//   - a candidate counts as an app when it contains a `rspack.config.*` or
//     `webpack.config.*` file, or `.repack-atlas/introspection.json`;
//     other packages matched by the globs are skipped;
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
  INTROSPECTION_RELATIVE_PATH,
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

const BUNDLER_CONFIG_PREFIXES = ['rspack.config.', 'webpack.config.'];
const NEVER_EXPANDED = new Set(['node_modules']);
// Native/build output that `**` never descends into (dot dirs and
// node_modules are pruned everywhere).
const STAR_STAR_PRUNED = new Set(['ios', 'android', 'build', 'dist', 'Pods']);
// ProjectFs cannot tell symlinks apart, so `**` is depth-capped instead of
// following links into cycles.
const MAX_GLOB_DEPTH = 8;

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

/** npm's package-name rules: lowercase, optional `@scope/`, max 214 chars. */
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9-._~]*\/)?[a-z0-9~-][a-z0-9-._~]*$/;

function isValidPackageName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name);
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
  if (!isValidPackageName(record.name)) {
    return { note: 'no command: package name is not a valid npm package name' };
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

function isPruned(name: string): boolean {
  return name.startsWith('.') || NEVER_EXPANDED.has(name);
}

/** Minimal reader for the `packages:` list of a pnpm-workspace.yaml. */
function parsePnpmWorkspacePackages(text: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd();
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s+(.*)$/.exec(line)?.[1]?.trim();
    if (item === undefined || item === '') continue;
    patterns.push(item.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return patterns;
}

function parsePackageJsonWorkspaces(text: string): string[] {
  try {
    const pkg = JSON.parse(text) as { workspaces?: unknown };
    const field = pkg.workspaces;
    const list = Array.isArray(field)
      ? field
      : typeof field === 'object' && field !== null
        ? (field as { packages?: unknown }).packages
        : undefined;
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizePattern(pattern: string): string[] {
  return pattern
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

function segmentRegExp(segment: string): RegExp {
  const source = segment
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}$`);
}

/** Does a workspace-relative dir match the segmented glob? */
function matchesGlob(segments: string[], dirSegments: string[]): boolean {
  const [head, ...rest] = segments;
  if (head === undefined) return dirSegments.length === 0;
  if (head === '**') {
    for (let skip = 0; skip <= dirSegments.length; skip += 1) {
      if (matchesGlob(rest, dirSegments.slice(skip))) return true;
    }
    return false;
  }
  const [first, ...others] = dirSegments;
  return (
    first !== undefined &&
    segmentRegExp(head).test(first) &&
    matchesGlob(rest, others)
  );
}

/** Expand one positive glob into existing workspace-relative directories. */
async function expandGlob(
  workspaceDir: string,
  segments: string[],
  fs: ProjectFs
): Promise<string[]> {
  const found = new Set<string>();
  const isDir = async (rel: string[]): Promise<boolean> =>
    (await fs.stat(path.join(workspaceDir, ...rel)))?.isDirectory === true;

  async function visit(base: string[], rest: string[]): Promise<void> {
    const [head, ...tail] = rest;
    if (head === undefined) {
      if (base.length > 0) found.add(base.join('/'));
      return;
    }
    if (head === '**') {
      await visit(base, tail);
      // Apps do not nest: stop below a dir that already is an app.
      if (base.length >= MAX_GLOB_DEPTH) return;
      if (base.length > 0 && (await isAppDir(path.join(workspaceDir, ...base), fs))) {
        return;
      }
      for (const name of (await fs.readdir(path.join(workspaceDir, ...base))).sort()) {
        if (isPruned(name) || STAR_STAR_PRUNED.has(name)) continue;
        if (!(await isDir([...base, name]))) continue;
        await visit([...base, name], rest);
      }
      return;
    }
    if (!head.includes('*')) {
      if (await isDir([...base, head])) await visit([...base, head], tail);
      return;
    }
    const matcher = segmentRegExp(head);
    for (const name of (await fs.readdir(path.join(workspaceDir, ...base))).sort()) {
      if (isPruned(name) || !matcher.test(name)) continue;
      if (await isDir([...base, name])) await visit([...base, name], tail);
    }
  }

  await visit([], segments);
  return [...found];
}

/** Workspace globs from pnpm-workspace.yaml and package.json, in that order. */
async function readWorkspaceGlobs(
  workspaceDir: string,
  fs: ProjectFs
): Promise<string[]> {
  const pnpm = await fs.readFile(path.join(workspaceDir, 'pnpm-workspace.yaml'));
  const pkg = await fs.readFile(path.join(workspaceDir, 'package.json'));
  return [
    ...(pnpm !== null ? parsePnpmWorkspacePackages(pnpm) : []),
    ...(pkg !== null ? parsePackageJsonWorkspaces(pkg) : []),
  ];
}

async function isAppDir(appDir: string, fs: ProjectFs): Promise<boolean> {
  const entries = await fs.readdir(appDir);
  if (
    entries.some((name) =>
      BUNDLER_CONFIG_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
  ) {
    return true;
  }
  return fs.exists(path.join(appDir, ...INTROSPECTION_RELATIVE_PATH));
}

/** Discover candidate app dirs, workspace-relative and sorted. */
async function discoverAppDirs(
  workspaceDir: string,
  fs: ProjectFs
): Promise<{ dirs: string[]; location: string }> {
  const globs = await readWorkspaceGlobs(workspaceDir, fs);
  let candidates: string[];
  let location: string;
  const positive = globs.filter((glob) => !glob.startsWith('!'));
  if (positive.length > 0) {
    const negative = globs
      .filter((glob) => glob.startsWith('!'))
      .map((glob) => normalizePattern(glob.slice(1)));
    const all = new Set<string>();
    for (const glob of positive) {
      for (const dir of await expandGlob(workspaceDir, normalizePattern(glob), fs)) {
        all.add(dir);
      }
    }
    candidates = [...all].filter(
      (dir) => !negative.some((neg) => matchesGlob(neg, dir.split('/')))
    );
    location = `the workspace globs (${positive.join(', ')})`;
  } else {
    const appsRoot = path.join(workspaceDir, 'apps');
    const appsStat = await fs.stat(appsRoot);
    const hasApps = appsStat !== null && appsStat.isDirectory;
    const scanDir = hasApps ? appsRoot : workspaceDir;
    const prefix = hasApps ? 'apps/' : '';
    candidates = [];
    for (const name of await fs.readdir(scanDir)) {
      if (!hasApps && (name === 'apps' || isPruned(name))) continue;
      const stat = await fs.stat(path.join(scanDir, name));
      if (stat !== null && stat.isDirectory) candidates.push(`${prefix}${name}`);
    }
    location = `the directory ${scanDir}`;
  }
  const dirs: string[] = [];
  for (const dir of candidates.sort()) {
    if (await isAppDir(path.join(workspaceDir, dir), fs)) dirs.push(dir);
  }
  return { dirs, location };
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

  const { dirs, location } = await discoverAppDirs(workspaceDir, fs);
  // Apps sharing a dir basename get a distinct name from their whole dir
  // (`a/x` -> `a-x`); unique basenames keep the plain one.
  const baseCounts = new Map<string, number>();
  for (const dir of dirs) {
    const base = path.posix.basename(dir);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const discovered = dirs.map((dir) => {
    const base = path.posix.basename(dir);
    return {
      dir,
      dirName: (baseCounts.get(base) ?? 0) > 1 ? dir.replaceAll('/', '-') : base,
    };
  });

  if (discovered.length === 0) {
    return {
      ok: false,
      reason:
        `no apps discovered under ${location} ` +
        '(an app is a directory containing a rspack.config.* or ' +
        'webpack.config.* file, or .repack-atlas/introspection.json)',
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
