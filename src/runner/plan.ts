// Pure dev-plan builder (ODD dev-wizard-runner T1): config + selected apps →
// the ordered list of apps `repack-atlas dev` would run. No I/O, no port
// probing, no spawning — those live in `supervisor.ts` so `--dry-run` and the
// live path share one plan. Order is fixed: host first, then remotes in
// declaration order.

import path from 'node:path';
import { isUrlSource, type FederationConfig } from '../core/index.js';

/** `--apps` / config key of the host entry (not its federation name). */
export const HOST_APP_KEY = 'host';

/** One app the runner will start, before any port is allocated. */
export interface DevPlanEntry {
  /** Config key: `host` or the remote's name in `remotes`. */
  key: string;
  /** Graph node name (host: its manifest `name`; remote: the config key). */
  name: string;
  role: 'host' | 'remote';
  command: string;
  /** Directory the command runs in (the config directory). */
  cwd: string;
  /** Declared TCP port; `null` means the runner picks a free one. */
  declaredPort: number | null;
  /** Absolute app root; absent when the config declares none. */
  root?: string;
  /** Absolute path of a file manifest; absent for URLs. */
  manifestPath?: string;
}

/** An app left out of the plan (listed in the config without a `command`). */
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
}

/** Resolve `root`/`manifest` refs the way the doctor does (URLs stay). */
function resolveRef(configDir: string, ref: string): string {
  return isUrlSource(ref) ? ref : path.resolve(configDir, ref);
}

const isTcpPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535;

/**
 * Build the spawn plan from the workspace config. Unknown `--apps` keys and
 * malformed declared ports come back as `reasons`; apps without a `command`
 * are skipped (reported in `skipped`), never guessed.
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

  for (const entry of selected) {
    const name = entry.role === 'host' ? hostName : entry.key;
    if (entry.command === undefined) {
      skipped.push({
        key: entry.key,
        name,
        reason:
          'no "command" in repack-federation.json — skipped (declare one to run it)',
      });
      continue;
    }
    if (entry.port !== undefined && !isTcpPort(entry.port)) {
      return {
        ok: false,
        reasons: [`${entry.key}.port must be a TCP port number (1-65535)`],
      };
    }
    entries.push({
      key: entry.key,
      name,
      role: entry.role,
      command: entry.command,
      cwd: configDir,
      declaredPort: entry.port ?? null,
      ...(entry.root !== undefined
        ? { root: path.resolve(configDir, entry.root) }
        : {}),
      ...(isUrlSource(entry.manifest)
        ? {}
        : { manifestPath: resolveRef(configDir, entry.manifest) }),
    });
  }

  return { ok: true, configDir, entries, skipped };
}

/** One app of the `{event:'plan'}` line; `port: null` means auto. */
export interface DevPlanEventApp {
  app: string;
  role: 'host' | 'remote';
  port: number | null;
  command: string;
  cwd: string;
}

/** Project plan entries to the stable `--json` / table shape. */
export function toPlanEventApps(entries: DevPlanEntry[]): DevPlanEventApp[] {
  return entries.map((entry) => ({
    app: entry.name,
    role: entry.role,
    port: entry.declaredPort,
    command: entry.command,
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
