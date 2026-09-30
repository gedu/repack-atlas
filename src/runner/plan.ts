// Pure dev-plan builder (ODD dev-wizard-runner T1): config + selected apps →
// the ordered list of apps `repack-atlas dev` would run. No I/O, no port
// probing, no spawning — those live in `supervisor.ts` so `--dry-run` and the
// live path share one plan. Order is fixed: host first, then remotes in
// declaration order.

import path from 'node:path';
import { isUrlSource, type FederationConfig } from '../core/index.js';
import { describeLaunch, type DevLaunch } from './start-argv.js';
import type { Toolchains } from './toolchain.js';

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
  /** `--platform` for built argvs (T4 wires the flag; `command` apps never
   * receive it). */
  platform?: 'ios' | 'android';
  /** Config key of the remote started with `--standalone` (T4 wires the flag
   * and its `standalone: true` gate). */
  standalone?: string;
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
  const selected = input.apps
    ? roster.filter((entry) => input.apps!.includes(entry.key))
    : roster;

  const entries: DevPlanEntry[] = [];
  const skipped: DevSkippedApp[] = [];
  const reasons: string[] = [];

  for (const entry of selected) {
    const name = entry.role === 'host' ? hostName : entry.key;
    if (entry.command === undefined && entry.root === undefined) {
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
      const toolchain = input.toolchains?.[appRoot];
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
        ...(entry.config !== undefined
          ? { config: path.resolve(configDir, entry.config) }
          : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.standalone === entry.key ? { standalone: true } : {}),
      };
      cwd = appRoot;
    }

    const manifestRef = resolveRef(configDir, entry.manifest);
    entries.push({
      key: entry.key,
      name,
      role: entry.role,
      launch,
      cwd,
      declaredPort:
        entry.role === 'host'
          ? (input.hostPort ?? entry.port ?? HOST_DEFAULT_PORT)
          : (entry.port ?? null),
      ...(root !== undefined ? { root } : {}),
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
}

/** Project plan entries to the stable `--json` / table shape. */
export function toPlanEventApps(entries: DevPlanEntry[]): DevPlanEventApp[] {
  return entries.map((entry) => ({
    app: entry.name,
    role: entry.role,
    port: entry.declaredPort,
    command: describeLaunch(entry.launch, entry.declaredPort, entry.cwd),
    cwd: entry.cwd,
  }));
}

/** Human plan table (`--dry-run`): app, role, port or `auto`, command, cwd. */
export function formatPlanTable(entries: DevPlanEntry[]): string {
  const header = ['app', 'role', 'port', 'command', 'cwd'];
  const rows = toPlanEventApps(entries).map((app) => [
    app.app,
    app.role,
    app.port === null ? 'auto' : String(app.port),
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
