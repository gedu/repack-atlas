// The `repack-atlas dev` supervisor (T9, docs/PRD.md §7.1): plans which apps
// to run, spawns each app's start command through the `ProcessRunner` port,
// and tracks one live status per app. This is a REIMPLEMENTATION of the
// concept in upstream #1467 (`federation-dev`) at demo scope — not a port:
// no wizard, no platforms, no launch, no adb. The upstream README
// (`website/src/latest/api/cli/federation-dev.mdx` @ feat/federation-dev-runner)
// was consulted for concepts only (prefixed logs, port probes before spawn,
// ordered SIGINT→grace→SIGTERM shutdown, one JSON event per transition).
//
// Command resolution semantics (locked here; mirrored in DEV_HELP and
// fixtures/README.md):
//   - An app runs only when its `repack-atlas.json` entry declares `command`
//     (schema: `src/core/federation-config.ts`). No command → the app is
//     skipped with a console warning, never silently guessed.
//   - The command runs through a platform shell (`sh -c` / `cmd /c`) with the
//     working directory set to the directory holding `repack-federation.json`
//     (the workspace root), so `node tools/stub-bundler.mjs` style relative
//     paths read naturally.
//   - The child receives `ATLAS_APP_NAME` (graph node name), `ATLAS_APP_PORT`
//     (the runner-resolved port), `ATLAS_APP_ROOT` (resolved `root`, may be
//     empty) and, for file manifests, `ATLAS_APP_MANIFEST`. A command that
//     wants the runner's port must read `ATLAS_APP_PORT` — the runner never
//     rewrites the user's command line.
//
// Readiness is ONE documented signal: the app's port answers on 127.0.0.1
// (two-leg `isPortBusy` probe). `bundling` is deliberately never claimed —
// Atlas cannot know a bundler's phase without a protocol, and rule 7 forbids
// guessing. Statuses are the `APP_RUNTIME_STATUSES` vocabulary from
// `src/core/graph.ts` so `/api/graph` and the runner agree by construction.

import path from 'node:path';
import {
  isUrlSource,
  type AppRuntimeStatus,
  type FederationConfig,
  type ManifestSource,
  type ProcessHandle,
  type ProcessRunner,
} from '../core/index.js';
import type { AtlasWorkspaceConfigReader } from '../adapters/index.js';
import {
  buildDevPlan,
  HOST_APP_KEY,
  type DevPlanEntry,
  type DevSkippedApp,
} from './plan.js';

/** Fallback node name when the host manifest cannot be read. */
const HOST_FALLBACK_NAME = 'host';

export { HOST_APP_KEY };

export interface DevAppPlan {
  /** Config key: `host` or the remote's name in `remotes`. */
  key: string;
  /** Graph node name (host: its manifest `name`; remote: the config key). */
  name: string;
  role: 'host' | 'remote';
  command: string;
  /** Runner-resolved port the readiness probe watches. */
  port: number;
  portSource: 'declared' | 'auto';
  root?: string;
  /** Absolute path of a file manifest; absent for URLs/unreadable refs. */
  manifestPath?: string;
}

export type { DevSkippedApp };

/** A plan with no ports allocated yet (what `--dry-run` reports). */
export interface LoadedDevPlan {
  configDir: string;
  entries: DevPlanEntry[];
  skipped: DevSkippedApp[];
}

export type DevPlanResult =
  | { ok: false; reasons: string[] }
  | {
      ok: true;
      configDir: string;
      /** Pure plan entries the live apps were allocated from. */
      entries: DevPlanEntry[];
      apps: DevAppPlan[];
      skipped: DevSkippedApp[];
      /** Apps listed in the config without a `command` (skipped, warned). */
      commandless: DevSkippedApp[];
    };

export interface DevPlanOptions {
  workspaceDir: string;
  configReader: AtlasWorkspaceConfigReader;
  manifestSource: ManifestSource;
  processRunner: ProcessRunner;
  /** `--apps` list (config keys). Unknown keys fail the plan. */
  apps?: string[];
}

/**
 * Read the config and host manifest, then build the pure plan. Reads files
 * but never probes or binds ports, so it is safe for `--dry-run`. Never
 * throws; failures come back as `reasons` (the CLI maps them to exit 2).
 */
export async function loadDevPlan(
  options: Omit<DevPlanOptions, 'processRunner'>
): Promise<({ ok: true } & LoadedDevPlan) | { ok: false; reasons: string[] }> {
  const loaded = await options.configReader.load(options.workspaceDir);
  if (loaded.status === 'missing') {
    return {
      ok: false,
      reasons: [
        `no repack-federation.json found walking up from ${options.workspaceDir}`,
      ],
    };
  }
  if (loaded.status === 'invalid') {
    return {
      ok: false,
      reasons: [`${loaded.filePath} ${loaded.reasons.join('; ')}`],
    };
  }

  const { config, filePath } = loaded;
  const configDir = path.dirname(filePath);

  // The host's graph node name is its manifest `name` (core/graph.ts
  // roster rule); statuses must be keyed by it for /api/graph to match.
  let hostName = HOST_FALLBACK_NAME;
  const hostManifestResult = await options.manifestSource.load(
    isUrlSource(config.host.manifest)
      ? config.host.manifest
      : path.resolve(configDir, config.host.manifest)
  );
  if (
    hostManifestResult.status === 'ok' &&
    typeof hostManifestResult.manifest.name === 'string' &&
    hostManifestResult.manifest.name
  ) {
    hostName = hostManifestResult.manifest.name;
  }

  const built = buildDevPlan({
    config,
    configDir,
    hostName,
    ...(options.apps !== undefined ? { apps: options.apps } : {}),
  });
  if (!built.ok) return built;
  return {
    ok: true,
    configDir,
    entries: built.entries,
    skipped: built.skipped,
  };
}

/**
 * Probe declared ports (busy → conflict) without binding anything. Shared by
 * the live allocation and `--dry-run`, which reports every conflict.
 */
export async function findPortConflicts(
  entries: DevPlanEntry[],
  processRunner: ProcessRunner
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const entry of entries) {
    if (
      entry.declaredPort !== null &&
      (await processRunner.isPortBusy(entry.declaredPort))
    ) {
      conflicts.push(
        `port ${entry.declaredPort} declared by ${entry.key} is already busy`
      );
    }
  }
  return conflicts;
}

/**
 * Load the plan and allocate ports for the live path: declared ports probed
 * BEFORE spawning (first busy one fails the plan); apps without one get an
 * OS-assigned free port. Never throws.
 */
export async function resolveDevPlan(
  options: DevPlanOptions
): Promise<DevPlanResult> {
  const loaded = await loadDevPlan(options);
  if (!loaded.ok) return loaded;

  const apps: DevAppPlan[] = [];
  for (const entry of loaded.entries) {
    let port: number;
    let portSource: DevAppPlan['portSource'];
    if (entry.declaredPort !== null) {
      if (await options.processRunner.isPortBusy(entry.declaredPort)) {
        return {
          ok: false,
          reasons: [
            `port ${entry.declaredPort} declared by ${entry.key} is already busy`,
          ],
        };
      }
      port = entry.declaredPort;
      portSource = 'declared';
    } else {
      port = await options.processRunner.findFreePort();
      portSource = 'auto';
    }
    apps.push({
      key: entry.key,
      name: entry.name,
      role: entry.role,
      command: entry.command,
      port,
      portSource,
      ...(entry.root !== undefined ? { root: entry.root } : {}),
      ...(entry.manifestPath !== undefined
        ? { manifestPath: entry.manifestPath }
        : {}),
    });
  }

  return {
    ok: true,
    configDir: loaded.configDir,
    entries: loaded.entries,
    apps,
    skipped: loaded.skipped,
    commandless: loaded.skipped,
  };
}

/** Everything the supervisor emits, as data (the CLI renders/serializes). */
export interface SupervisorEvents {
  /** Prefixed-ready log line from a child. */
  onLog(app: string, stream: 'stdout' | 'stderr', line: string): void;
  /** One call per status TRANSITION (never for repeats). `pid` is the live
   * child's pid (process-group leader) while one exists. */
  onStatus(
    app: string,
    status: AppRuntimeStatus,
    port: number,
    pid?: number
  ): void;
}

export interface DevSupervisorOptions extends SupervisorEvents {
  plan: Extract<DevPlanResult, { ok: true }>;
  processRunner: ProcessRunner;
  /** Delay between spawns; keeps log interleaving readable. */
  staggerMs?: number;
  /** Port-poll interval for the readiness probe. */
  pollMs?: number;
  /** Grace window inside killTree before SIGTERM escalation. */
  killGraceMs?: number;
}

interface ManagedApp {
  plan: DevAppPlan;
  status: AppRuntimeStatus;
  handle: ProcessHandle | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Spawn-and-watch session over a resolved plan. Owns the children's
 * lifecycles and the status map; knows nothing about HTTP, the Studio or
 * argv. `start()` resolves once every child is spawned (readiness arrives
 * later through `onStatus`); `shutdown()` is idempotent and always resolves.
 */
export function createDevSupervisor(options: DevSupervisorOptions) {
  const pollMs = options.pollMs ?? 150;
  const staggerMs = options.staggerMs ?? 100;
  const killGraceMs = options.killGraceMs ?? 2_000;

  const managed: ManagedApp[] = options.plan.apps.map((plan) => ({
    plan,
    status: 'idle' as AppRuntimeStatus,
    handle: null,
  }));

  let shuttingDown = false;
  let poller: ReturnType<typeof setInterval> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  function setStatus(app: ManagedApp, status: AppRuntimeStatus): void {
    if (app.status === status) return;
    app.status = status;
    const pid = app.handle?.pid ?? null;
    if (pid !== null) {
      options.onStatus(app.plan.name, status, app.plan.port, pid);
    } else {
      options.onStatus(app.plan.name, status, app.plan.port);
    }
  }

  function envFor(plan: DevAppPlan): Record<string, string> {
    const env: Record<string, string> = {
      ATLAS_APP_NAME: plan.name,
      ATLAS_APP_PORT: String(plan.port),
      ATLAS_APP_ROOT: plan.root ?? '',
    };
    if (plan.manifestPath !== undefined) {
      env.ATLAS_APP_MANIFEST = plan.manifestPath;
    }
    return env;
  }

  async function startApp(app: ManagedApp): Promise<void> {
    if (shuttingDown) return;
    const handle = options.processRunner.start({
      file: app.plan.command,
      args: [],
      cwd: options.plan.configDir,
      env: envFor(app.plan),
      shell: true,
    });
    app.handle = handle;
    setStatus(app, 'starting');

    handle.subscribeToStdout((line) =>
      options.onLog(app.plan.name, 'stdout', line)
    );
    handle.subscribeToStderr((line) =>
      options.onLog(app.plan.name, 'stderr', line)
    );

    void handle.waitForExit().then(({ code, signal }) => {
      app.handle = null;
      // Ordered shutdown is an expected death: `stopped`, whatever the
      // signal. Unexpected deaths are `error` (exit != 0 or a crash).
      if (shuttingDown || (code === 0 && signal === null)) {
        setStatus(app, 'stopped');
      } else {
        setStatus(app, 'error');
      }
    });
  }

  async function poll(): Promise<void> {
    for (const app of managed) {
      if (shuttingDown) return;
      if (app.status === 'starting') {
        if (await options.processRunner.isPortBusy(app.plan.port)) {
          setStatus(app, 'ready');
        }
      }
    }
  }

  return {
    /** Spawn every planned app, staggered. Resolves after the last spawn. */
    async start(): Promise<void> {
      for (const app of managed) {
        await startApp(app);
        if (staggerMs > 0 && app !== managed[managed.length - 1]) {
          await sleep(staggerMs);
        }
      }
      if (managed.length > 0) {
        poller = setInterval(() => void poll(), pollMs);
      }
    },

    /** Live status map keyed by graph node name (for the Studio source). */
    statuses(): Record<string, AppRuntimeStatus> {
      const map: Record<string, AppRuntimeStatus> = {};
      for (const app of managed) map[app.plan.name] = app.status;
      return map;
    },

    /** True when any app died unexpectedly (maps the session to exit 1). */
    hasErrors(): boolean {
      return managed.some((app) => app.status === 'error');
    },

    /** Pids of live children (tests and diagnostics only). */
    pids(): Record<string, number | null> {
      const map: Record<string, number | null> = {};
      for (const app of managed) map[app.plan.name] = app.handle?.pid ?? null;
      return map;
    },

    /** Idempotent ordered shutdown: SIGINT→grace→killTree, then stopped. */
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      if (poller !== null) {
        clearInterval(poller);
        poller = null;
      }
      shutdownPromise = (async () => {
        const handles = managed
          .map((app) => app.handle)
          .filter((handle): handle is ProcessHandle => handle !== null);
        await Promise.all(handles.map((handle) => handle.killTree(killGraceMs)));
        // `error` is a fact about the session that shutdown must not erase
        // (it also feeds hasErrors() → exit code 1).
        for (const app of managed) {
          if (app.status !== 'idle' && app.status !== 'error') {
            setStatus(app, 'stopped');
          }
        }
      })();
      return shutdownPromise;
    },
  };
}

/** Exported for the CLI's help text and fixtures/README.md parity. */
export const DEV_ENV_VARS = [
  'ATLAS_APP_NAME',
  'ATLAS_APP_PORT',
  'ATLAS_APP_ROOT',
  'ATLAS_APP_MANIFEST',
] as const;

/** Re-export so consumers can type plans without importing core twice. */
export type DevFederationConfig = FederationConfig;
