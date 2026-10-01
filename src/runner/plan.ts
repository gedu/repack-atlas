// Pure dev-plan builder (ODD dev-wizard-runner T1): config + selected apps →
// the ordered list of apps `repack-atlas dev` would run. No I/O, no port
// probing, no spawning — those live in `supervisor.ts` so `--dry-run` and the
// live path share one plan. Order is fixed: host first, then remotes in
// declaration order.

import path from 'node:path';
import {
  FEDERATION_CONFIG_FILENAME,
  isUrlSource,
  type FederationConfig,
} from '../core/index.js';
import {
  declaresStartOption,
  describeLaunch,
  type DevLaunch,
} from './start-argv.js';
import { toolchainKey, type Toolchains } from './toolchain.js';

/** Platforms `--platform` accepts (the two native compile scopes). */
export type DevPlatform = 'ios' | 'android';

export const DEV_PLATFORMS: readonly DevPlatform[] = ['ios', 'android'];

/** `--apps` / config key of the host entry (not its federation name). */
export const HOST_APP_KEY = 'host';

/** Host port when neither `--port` nor the config's host `port` is set. */
export const HOST_DEFAULT_PORT = 8081;

/** One app the runner will start, before any port is allocated. */
export interface DevPlanEntry {
  /** Config key: `host` or the remote's name in `remotes`. */
  key: string;
  /** Graph node name (host: its manifest `name`; remote: the config key). */
  name: string;
  role: 'host' | 'remote';
  /** `command` = verbatim shell override; `argv` = Atlas-built start argv. */
  launch: DevLaunch;
  /** Directory the app runs in: the config directory for a `command`, the
   * app root for a built argv. */
  cwd: string;
  /** Declared TCP port (host: `--port` > config > 8081); `null` = runner picks. */
  declaredPort: number | null;
  /** The busy port `--auto-ports` moved this app away from (set by
   * `applyAssignments`, never by the plan builder). */
  reassignedFrom?: number;
  /** `--platform` of the session; built argvs get `--platform`, `command`
   * apps only the `ATLAS_APP_PLATFORM` env var. */
  platform?: DevPlatform;
  /** True on the one remote started with `--standalone` (argv flag, or the
   * `ATLAS_APP_STANDALONE=1` env var for a `command` app). */
  standalone?: true;
  /** Absolute app root; absent when the config declares none. */
  root?: string;
  /** Absolute path of a file manifest; absent for URLs. */
  manifestPath?: string;
}

/** An app left out of the plan (declares neither a `command` nor a `root`). */
export interface DevSkippedApp {
  key: string;
  name: string;
  reason: string;
}

export type BuildDevPlanResult =
  | { ok: false; reasons: string[] }
  | {
      ok: true;
      configDir: string;
      entries: DevPlanEntry[];
      skipped: DevSkippedApp[];
    };

export interface BuildDevPlanInput {
  config: FederationConfig;
  /** Absolute directory holding `repack-federation.json`. */
  configDir: string;
  /** Graph node name of the host (its manifest `name`, or a fallback). */
  hostName: string;
  /** `--apps` list (config keys). Unknown keys fail the plan. */
  apps?: string[];
  /** `--port`: overrides the HOST port only (already validated 1-65535). */
  hostPort?: number;
  /** Resolved bundler + RN CLI per absolute app root (see `toolchain.ts`).
   * Consulted only for apps that run the default argv. */
  toolchains?: Toolchains;
  /** `--platform` (already validated). Built argvs get `--platform`; a
   * `command` is never rewritten and sees only the env var. */
  platform?: DevPlatform;
  /** Config key of the remote started with `--standalone`. It must be a
   * declared remote with `standalone: true` (else the plan fails) and joins
   * the session even when `--apps` omitted it, as upstream #1467 does. */
  standalone?: string;
  /** Per-app port overrides by config key (the wizard's answers, already
   * validated 1-65535). They beat the declared port and `hostPort`. */
  ports?: Readonly<Record<string, number>>;
}

/**
 * Whether the config key is part of the session: no `--apps` = everyone;
 * otherwise the listed keys plus the `--standalone` remote (implied in).
 */
export function isAppSelected(
  key: string,
  apps: readonly string[] | undefined,
  standalone: string | undefined
): boolean {
  return apps === undefined || apps.includes(key) || standalone === key;
}

/** Resolve `root`/`manifest` refs the way the doctor does (URLs stay). */
export function resolveRef(configDir: string, ref: string): string {
  return isUrlSource(ref) ? ref : path.resolve(configDir, ref);
}

const isTcpPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535;

/**
 * Build the spawn plan from the workspace config. An app with a `command`
 * runs it verbatim; one with only a `root` runs the built
 * `react-native start` argv. Unknown `--apps` keys, malformed declared ports
 * and unresolvable toolchains come back as `reasons`; apps with neither are
 * skipped (reported in `skipped`), never guessed.
 */
export function buildDevPlan(input: BuildDevPlanInput): BuildDevPlanResult {
  const { config, configDir, hostName } = input;

  const roster = [
    { key: HOST_APP_KEY, role: 'host' as const, ...config.host },
    ...Object.entries(config.remotes).map(([key, remote]) => ({
      key,
      role: 'remote' as const,
      ...remote,
    })),
  ];

  if (input.apps) {
    const known = new Set(roster.map((entry) => entry.key));
    const unknown = input.apps.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      return {
        ok: false,
        reasons: [
          `--apps names unknown apps: ${unknown.join(', ')} (known: ${[...known].sort().join(', ')})`,
        ],
      };
    }
  }

  if (input.standalone !== undefined) {
    const remote = config.remotes[input.standalone];
    if (remote === undefined) {
      return {
        ok: false,
        reasons: [
          `--standalone names an unknown remote: ${input.standalone} (known remotes: ${Object.keys(config.remotes).join(', ') || '(none)'})`,
        ],
      };
    }
    // Upstream `assertRemoteStandalone`: only `standalone: true` passes.
    if (remote.standalone !== true) {
      return {
        ok: false,
        reasons: [
          `--standalone refused: remote "${input.standalone}" does not declare standalone support. Set "standalone": true for it in ${path.join(configDir, FEDERATION_CONFIG_FILENAME)}.`,
        ],
      };
    }
  }

  // `--standalone r` implies r is in the session even when `--apps` omitted it.
  const selected = roster.filter((entry) =>
    isAppSelected(entry.key, input.apps, input.standalone)
  );

  const entries: DevPlanEntry[] = [];
  const skipped: DevSkippedApp[] = [];
  const reasons: string[] = [];

  for (const entry of selected) {
    const name = entry.role === 'host' ? hostName : entry.key;
    if (entry.command === undefined && entry.root === undefined) {
      if (input.standalone === entry.key) {
        // A silent skip would drop the very app the user asked to run.
        return {
          ok: false,
          reasons: [
            `--standalone ${entry.key}: the remote declares neither "command" nor "root" in repack-federation.json, so it cannot run`,
          ],
        };
      }
      skipped.push({
        key: entry.key,
        name,
        reason:
          'no "command" or "root" in repack-federation.json — skipped (declare one to run it)',
      });
      continue;
    }
    if (entry.port !== undefined && !isTcpPort(entry.port)) {
      return {
        ok: false,
        reasons: [`${entry.key}.port must be a TCP port number (1-65535)`],
      };
    }
    const root =
      entry.root !== undefined ? path.resolve(configDir, entry.root) : undefined;

    let launch: DevLaunch;
    let cwd = configDir;
    if (entry.command !== undefined) {
      launch = { kind: 'command', command: entry.command };
    } else {
      // `root` is defined here: commandless + rootless apps were skipped.
      const appRoot = root!;
      const toolchain = input.toolchains?.[toolchainKey(appRoot, entry.config)];
      if (toolchain === undefined || !toolchain.ok) {
        reasons.push(
          `${entry.key}: ${toolchain?.reason ?? 'toolchain was not resolved'} (app root ${appRoot})`
        );
        continue;
      }
      launch = {
        kind: 'argv',
        file: process.execPath,
        cli: toolchain.cli,
        bundler: toolchain.bundler,
        ...(toolchain.startOptions !== undefined
          ? { startOptions: toolchain.startOptions }
          : {}),
        ...(toolchain.startOptionsNote !== undefined
          ? { startOptionsNote: toolchain.startOptionsNote }
          : {}),
        ...(entry.config !== undefined
          ? { config: path.resolve(configDir, entry.config) }
          : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.standalone === entry.key ? { standalone: true } : {}),
      };
      cwd = appRoot;
      if (
        input.standalone === entry.key &&
        !declaresStartOption(launch, '--standalone')
      ) {
        reasons.push(
          `${entry.key}: --standalone refused: ${
            toolchain.startOptions !== undefined
              ? "the installed Re.Pack's start command has no --standalone option (it needs a Re.Pack build with federation dev-runner support, callstack/repack PR #1467)"
              : `cannot confirm that the installed start command has --standalone (${toolchain.startOptionsNote ?? 'its options could not be read'})`
          }. Give the app a "command" that starts it standalone, or drop --standalone.`
        );
        continue;
      }
    }

    const manifestRef = resolveRef(configDir, entry.manifest);
    entries.push({
      key: entry.key,
      name,
      role: entry.role,
      launch,
      cwd,
      declaredPort:
        input.ports?.[entry.key] ??
        (entry.role === 'host'
          ? (input.hostPort ?? entry.port ?? HOST_DEFAULT_PORT)
          : (entry.port ?? null)),
      ...(root !== undefined ? { root } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.standalone === entry.key ? { standalone: true as const } : {}),
      ...(isUrlSource(manifestRef) ? {} : { manifestPath: manifestRef }),
    });
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, configDir, entries, skipped };
}

/** One app of the `{event:'plan'}` line; `port: null` means auto. */
export interface DevPlanEventApp {
  app: string;
  role: 'host' | 'remote';
  port: number | null;
  /** Effective command line: verbatim `command`, or `node <cli> start ...`
   * for a built argv (see `describeLaunch`). */
  command: string;
  cwd: string;
  /** Additive: the busy port `--auto-ports` moved this app away from. */
  reassignedFrom?: number;
  /** Additive: the session `--platform`, when one was given. */
  platform?: DevPlatform;
  /** Additive: true on the `--standalone` remote. */
  standalone?: true;
  /** Additive: the bundler detected for a built argv (informational: it is
   * passed as `--bundler` only when the installed `start` supports it). */
  bundler?: 'rspack' | 'webpack';
}

/** Project plan entries to the stable `--json` / table shape. */
export function toPlanEventApps(entries: DevPlanEntry[]): DevPlanEventApp[] {
  return entries.map((entry) => ({
    app: entry.name,
    role: entry.role,
    port: entry.declaredPort,
    command: describeLaunch(entry.launch, entry.declaredPort, entry.cwd),
    cwd: entry.cwd,
    ...(entry.reassignedFrom !== undefined
      ? { reassignedFrom: entry.reassignedFrom }
      : {}),
    ...(entry.platform !== undefined ? { platform: entry.platform } : {}),
    ...(entry.standalone === true ? { standalone: true as const } : {}),
    ...(entry.launch.kind === 'argv' ? { bundler: entry.launch.bundler } : {}),
  }));
}

/**
 * Human plan table (`--dry-run`): app, role, port or `auto`, command, cwd. A
 * `--platform` adds a `platform` column (it is the only place a `command`
 * app shows it, as `ATLAS_APP_PLATFORM`); the `--standalone` remote's role
 * reads `remote (standalone)`.
 */
export function formatPlanTable(entries: DevPlanEntry[]): string {
  const withPlatform = entries.some((entry) => entry.platform !== undefined);
  const header = [
    'app',
    'role',
    'port',
    ...(withPlatform ? ['platform'] : []),
    'command',
    'cwd',
  ];
  const rows = toPlanEventApps(entries).map((app) => [
    app.app,
    app.standalone === true ? `${app.role} (standalone)` : app.role,
    app.port === null ? 'auto' : String(app.port),
    ...(withPlatform ? [app.platform ?? '-'] : []),
    app.command,
    app.cwd,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length))
  );
  const render = (row: string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd();
  return [render(header), ...rows.map(render)].join('\n');
}
