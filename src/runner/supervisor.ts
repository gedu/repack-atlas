// The `repack-atlas dev` supervisor (T9, docs/PRD.md §7.1): plans which apps
// to run, spawns each app (its command or built argv) through the `ProcessRunner` port,
// and tracks one live status per app. This is a REIMPLEMENTATION of the
// concept in upstream #1467 (`federation-dev`) at demo scope — not a port:
// the wizard lives in `src/cli/dev-wizard.ts`, there is no adb. The upstream README
// (`website/src/latest/api/cli/federation-dev.mdx` @ feat/federation-dev-runner)
// was consulted for concepts only (prefixed logs, port probes before spawn,
// ordered SIGINT→grace→SIGTERM shutdown, one JSON event per transition).
//
// Launch semantics (locked here; mirrored in DEV_HELP and fixtures/README.md):
//   - An app declaring `command` runs it verbatim through a platform shell
//     (`sh -c` / `cmd /c`) with the directory holding `repack-federation.json`
//     as cwd, so `node tools/stub-bundler.mjs` style relative paths read
//     naturally. A command that wants the runner's port must read
//     `ATLAS_APP_PORT` — the runner never rewrites a user's command line.
//   - An app with only a `root` runs the argv Atlas builds (`src/runner/
//     start-argv.ts`, upstream #1467 parity): `<the app's own
//     node_modules/.bin/react-native shim | node <its react-native CLI>> start
//     [--bundler <detected>] [--config <path>] --port N --no-interactive`,
//     spawned WITHOUT a shell and with the app root as cwd. The one exception
//     is a Windows `.cmd` shim, run as `cmd.exe /d /s /c "<quoted line>"` with
//     verbatim arguments (every argument quoted, never `shell: true`).
//   - An app with neither is skipped with a console warning, never guessed.
//   - Both kinds receive `ATLAS_APP_NAME` (graph node name), `ATLAS_APP_PORT`
//     (the runner-resolved port), `ATLAS_APP_ROOT` (resolved `root`, may be
//     empty) and, for file manifests, `ATLAS_APP_MANIFEST`. With `--platform`
//     they also get `ATLAS_APP_PLATFORM`, and the `--standalone` remote gets
//     `ATLAS_APP_STANDALONE=1`: a `command` is never rewritten, so env is
//     its only channel; built argvs carry the flags themselves. Neither var
//     is inherited: when the runner does not set one, a stray value from the
//     user's shell is removed from the child's environment.
//   - `--launch` adds ONE supervised one-shot child (`spawnOneShot`): no
//     readiness probe, logs as `[launch]`, killed on shutdown, and its exit
//     never touches `hasErrors()`. `onFirstReady` is the trigger hook.
//
// Readiness is ONE documented signal: the app's port answers on 127.0.0.1
// (two-leg `isPortBusy` probe). `bundling` is deliberately never claimed —
// Atlas cannot know a bundler's phase without a protocol, and rule 7 forbids
// guessing. Statuses are the `APP_RUNTIME_STATUSES` vocabulary from
// `src/core/graph.ts` so `/api/graph` and the runner agree by construction.

import path from 'node:path';
import {
  type AppRuntimeStatus,
  type FederationConfig,
  type ManifestSource,
  type ProcessHandle,
  type ProcessRunner,
  type ProjectFs,
  type ReactNativeCliResolver,
} from '../core/index.js';
import type { AtlasWorkspaceConfigReader } from '../adapters/index.js';
import {
  buildDevPlan,
  HOST_APP_KEY,
  isAppSelected,
  resolveRef,
  type DevPlanEntry,
  type DevPlanWarning,
  type DevPlatform,
  type DevSkippedApp,
} from './plan.js';
import {
  allocatePorts,
  applyAssignments,
  describeReassignments,
  PORT_CONFLICT_HINT,
} from './ports.js';
import {
  buildLaunchPlan,
  LAUNCH_NEEDS_PLATFORM_REASON,
  type LaunchPlan,
} from './launch-plan.js';
import { cmdShimSpawn, startArgs, type DevLaunch } from './start-argv.js';
import { resolveToolchains } from './toolchain.js';

/**
 * Spawn shape of one argv child: direct (`shell: false`), except a Windows
 * `.cmd` shim, which goes through `cmd.exe` with every argument quoted.
 */
function shimSpawn(
  file: string,
  args: string[],
  cmdShim: boolean | undefined
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  return cmdShim === true ? cmdShimSpawn(file, args) : { file, args };
}

/** Fallback node name when the host manifest cannot be read. */
const HOST_FALLBACK_NAME = 'host';

export { HOST_APP_KEY };

export interface DevAppPlan {
  /** Config key: `host` or the remote's name in `remotes`. */
  key: string;
  /** Graph node name (host: its manifest `name`; remote: the config key). */
  name: string;
  role: 'host' | 'remote';
  launch: DevLaunch;
  /** Directory the app is spawned in. */
  cwd: string;
  /** Runner-resolved port the readiness probe watches. */
  port: number;
  /** `reassigned`: a busy declared/default port moved by `--auto-ports`. */
  portSource: 'declared' | 'auto' | 'reassigned';
  /** The port a `reassigned` app gave up. */
  reassignedFrom?: number;
  /** Session `--platform` (env `ATLAS_APP_PLATFORM`). */
  platform?: DevPlatform;
  /** The `--standalone` remote (env `ATLAS_APP_STANDALONE=1`). */
  standalone?: true;
  root?: string;
  /** Absolute path of a file manifest; absent for URLs/unreadable refs. */
  manifestPath?: string;
}

export type { DevPlanWarning, DevSkippedApp };

/** A plan with no ports allocated yet (what `--dry-run` reports). */
export interface LoadedDevPlan {
  configDir: string;
  entries: DevPlanEntry[];
  skipped: DevSkippedApp[];
  /** Assumptions made for apps that do run (reported, never silent). */
  warnings: DevPlanWarning[];
  /** Config keys of the remotes declaring `standalone: true` (the wizard
   * offers standalone only for these). */
  standaloneRemotes: string[];
  /** Present only with `--launch`: the one-shot app launch. */
  launch?: LaunchPlan;
}

export type DevPlanResult =
  | {
      ok: false;
      reasons: string[];
      /** Set when the plan failed only on busy ports (exit 1, not 2). */
      portConflict?: true;
      /** Additive (ODD dev-port-conflict-warn-kill): the busy declared ports
       * behind a `portConflict` — the human path's orphan flow resolves the
       * owner of exactly these. Absent on every other failure. */
      busyPorts?: number[];
      /** Additive: absolute app dirs of this workspace (entry roots; the
       * cwd of argv-launched apps without one). Input for the orphan
       * matcher, alongside `busyPorts`. */
      appDirs?: string[];
    }
  | {
      ok: true;
      configDir: string;
      /** Pure plan entries the live apps were allocated from. */
      entries: DevPlanEntry[];
      apps: DevAppPlan[];
      /** Apps with neither `command` nor `root` (left out, warned). */
      skipped: DevSkippedApp[];
      warnings: DevPlanWarning[];
      /** One line per `--auto-ports` reassignment (empty when none). */
      reassignments: string[];
      /** Present only with `--launch`. */
      launch?: LaunchPlan;
    };

export interface DevPlanOptions {
  workspaceDir: string;
  configReader: AtlasWorkspaceConfigReader;
  manifestSource: ManifestSource;
  processRunner: ProcessRunner;
  /** Lists the app roots' bundler config files (default-argv apps only). */
  fs: ProjectFs;
  /** Resolves each app's own `react-native` CLI (default-argv apps only). */
  reactNativeCli: ReactNativeCliResolver;
  /** `--apps` list (config keys). Unknown keys fail the plan. */
  apps?: string[];
  /** `--port`: host port override (validated by the CLI). */
  hostPort?: number;
  /** `--platform` (validated by the CLI). */
  platform?: DevPlatform;
  /** Remote key started with `--standalone` (gated on `standalone: true`). */
  standalone?: string;
  /** Per-app port overrides by config key (wizard answers, validated). */
  ports?: Readonly<Record<string, number>>;
  /** `--auto-ports`: busy declared ports move to a free port. */
  autoPorts?: boolean;
  /** `--launch` (needs `platform`; the CLI gates that first, this plan
   * re-checks with the same reason for callers that skip the CLI) + `--device`. */
  launch?: { device?: string };
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
    resolveRef(configDir, config.host.manifest)
  );
  if (
    hostManifestResult.status === 'ok' &&
    typeof hostManifestResult.manifest.name === 'string' &&
    hostManifestResult.manifest.name
  ) {
    hostName = hostManifestResult.manifest.name;
  }

  // Only the selected apps that run the default argv need a toolchain;
  // resolving an unselected app's CLI could fail a run that never uses it.
  const targets = [
    { key: HOST_APP_KEY, ...config.host },
    ...Object.entries(config.remotes).map(([key, remote]) => ({ key, ...remote })),
  ]
    .filter(
      (app) =>
        app.command === undefined &&
        app.root !== undefined &&
        isAppSelected(app.key, options.apps, options.standalone)
    )
    .map((app) => ({
      root: path.resolve(configDir, app.root!),
      ...(app.config !== undefined ? { config: app.config } : {}),
    }));
  // Apps sharing a root and config resolve once (`resolveToolchains` dedupes).
  const toolchains = await resolveToolchains(targets, {
    fs: options.fs,
    reactNativeCli: options.reactNativeCli,
  });

  const built = buildDevPlan({
    config,
    configDir,
    hostName,
    toolchains,
    ...(options.apps !== undefined ? { apps: options.apps } : {}),
    ...(options.hostPort !== undefined ? { hostPort: options.hostPort } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.standalone !== undefined
      ? { standalone: options.standalone }
      : {}),
    ...(options.ports !== undefined ? { ports: options.ports } : {}),
  });
  if (!built.ok) return built;

  let launch: LaunchPlan | undefined;
  if (options.launch !== undefined) {
    if (options.platform === undefined) {
      return { ok: false, reasons: [LAUNCH_NEEDS_PLATFORM_REASON] };
    }
    const launchPlan = buildLaunchPlan({
      entries: built.entries,
      platform: options.platform,
      ...(options.launch.device !== undefined
        ? { device: options.launch.device }
        : {}),
      resolveCli: (root) => options.reactNativeCli.resolve(root),
    });
    if (!launchPlan.ok) return { ok: false, reasons: [launchPlan.reason] };
    launch = launchPlan.launch;
  }
  return {
    ok: true,
    configDir,
    entries: built.entries,
    skipped: built.skipped,
    warnings: built.warnings,
    standaloneRemotes: Object.entries(config.remotes)
      .filter(([, remote]) => remote.standalone === true)
      .map(([key]) => key),
    ...(launch !== undefined ? { launch } : {}),
  };
}

/**
 * Load the plan and allocate ports for the live path. Declared ports are
 * probed BEFORE spawning through the same `allocatePorts` the `--dry-run`
 * uses: every busy one is collected (or reassigned with `autoPorts`); apps
 * without a port get an OS-assigned free one. Never throws.
 */
export async function resolveDevPlan(
  options: DevPlanOptions
): Promise<DevPlanResult> {
  const loaded = await loadDevPlan(options);
  if (!loaded.ok) return loaded;

  const allocation = await allocatePorts(loaded.entries, options.processRunner, {
    autoPorts: options.autoPorts ?? false,
    resolveAuto: true,
  });
  if (!allocation.ok) {
    if (!allocation.busyPorts) {
      return {
        ok: false,
        reasons: [...allocation.conflicts, PORT_CONFLICT_HINT],
        portConflict: true,
      };
    }
    // App dirs of THIS workspace: an argv-launched app's own root (a command
    // app's cwd is the config dir, which proves nothing about the owner).
    const appDirs = [
      ...new Set(
        loaded.entries.flatMap((entry) =>
          entry.root !== undefined
            ? [entry.root]
            : entry.launch.kind === 'argv'
              ? [entry.cwd]
              : []
        )
      ),
    ];
    return {
      ok: false,
      reasons: [...allocation.conflicts, PORT_CONFLICT_HINT],
      portConflict: true,
      busyPorts: allocation.busyPorts,
      appDirs,
    };
  }

  // Entries carry the allocated ports (the plan event and argv read them).
  const entries = applyAssignments(loaded.entries, allocation.assignments);
  const assignmentByKey = new Map(allocation.assignments.map((a) => [a.key, a]));
  const apps: DevAppPlan[] = entries.map((entry) => {
    const assignment = assignmentByKey.get(entry.key)!;
    return {
      key: entry.key,
      name: entry.name,
      role: entry.role,
      launch: entry.launch,
      cwd: entry.cwd,
      // resolveAuto: true → every assignment carries a concrete port.
      port: assignment.port!,
      portSource: assignment.source,
      ...(entry.reassignedFrom !== undefined
        ? { reassignedFrom: entry.reassignedFrom }
        : {}),
      ...(entry.platform !== undefined ? { platform: entry.platform } : {}),
      ...(entry.standalone === true ? { standalone: true as const } : {}),
      ...(entry.root !== undefined ? { root: entry.root } : {}),
      ...(entry.manifestPath !== undefined
        ? { manifestPath: entry.manifestPath }
        : {}),
    };
  });

  return {
    ok: true,
    configDir: loaded.configDir,
    entries,
    apps,
    skipped: loaded.skipped,
    warnings: loaded.warnings,
    reassignments: describeReassignments(allocation.assignments),
    ...(loaded.launch !== undefined ? { launch: loaded.launch } : {}),
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
  /**
   * Lifecycle of a one-shot child (the `--launch` run). `exited` carries the
   * raw result; a child that could not be spawned arrives as `spawn-failed`.
   * Not called for the kill `shutdown()` itself causes. A throwing hook is
   * contained: it never breaks supervision of the child.
   */
  onOneShot?(name: string, event: OneShotEvent): void;
}

export type OneShotEvent =
  | { status: 'started'; pid: number | null }
  | { status: 'exited'; code: number | null; signal: string | null }
  | { status: 'spawn-failed' };

/** `ProcessHandle.waitForExit` reports a failed spawn with this signal. */
const SPAWN_ERROR_SIGNAL = 'spawn-error';

/** What `spawnOneShot` runs (the launch plan's spawn shape). */
export interface OneShotSpec {
  file: string;
  args: string[];
  cwd: string;
  /** A Windows `.cmd` shim: spawned through `cmd.exe` with quoted args. */
  shell?: boolean;
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

  const oneShots = new Set<ProcessHandle>();
  const firstReady = new Map<string, Array<() => void>>();

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
    if (status === 'ready') {
      // Taken out of the map before running, so each callback fires once.
      const callbacks = firstReady.get(app.plan.key) ?? [];
      firstReady.delete(app.plan.key);
      for (const callback of callbacks) {
        try {
          callback();
        } catch {
          // A hook must never break the poll loop that drives readiness.
        }
      }
    }
  }

  function envFor(plan: DevAppPlan): Record<string, string | undefined> {
    // `undefined` removes the key: a value the user's shell happens to export
    // must not pass for the runner's answer to "no manifest/platform/standalone".
    return {
      ATLAS_APP_NAME: plan.name,
      ATLAS_APP_PORT: String(plan.port),
      ATLAS_APP_ROOT: plan.root ?? '',
      ATLAS_APP_MANIFEST: plan.manifestPath,
      ATLAS_APP_PLATFORM: plan.platform,
      ATLAS_APP_STANDALONE: plan.standalone === true ? '1' : undefined,
    };
  }

  async function startApp(app: ManagedApp): Promise<void> {
    if (shuttingDown) return;
    const { launch } = app.plan;
    const handle = options.processRunner.start(
      launch.kind === 'command'
        ? {
            file: launch.command,
            args: [],
            cwd: app.plan.cwd,
            env: envFor(app.plan),
            shell: true,
          }
        : {
            ...shimSpawn(launch.file, startArgs(launch, app.plan.port), launch.shell),
            cwd: app.plan.cwd,
            env: envFor(app.plan),
          }
    );
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

    /**
     * Run `callback` once, the first time the app with config key `appKey`
     * turns `ready`. Register before `start()`; a key that never becomes
     * ready (or is not in the plan) never fires.
     */
    onFirstReady(appKey: string, callback: () => void): void {
      const list = firstReady.get(appKey) ?? [];
      list.push(callback);
      firstReady.set(appKey, list);
    },

    /**
     * Attach a supervised one-shot child (the app launch): no readiness
     * probe, no status row, logs through `onLog` under `name`, killed with
     * the apps on `shutdown()`. Never throws and never affects
     * `hasErrors()`; its outcome is reported through `onOneShot` only.
     */
    spawnOneShot(name: string, spec: OneShotSpec): void {
      if (shuttingDown) return;
      // A reporting hook that throws must neither crash the session nor
      // leave the child unsupervised: contain it at every call.
      const notify = (event: OneShotEvent): void => {
        try {
          options.onOneShot?.(name, event);
        } catch {
          // The hook only reports; supervision carries on.
        }
      };
      let handle: ProcessHandle;
      try {
        handle = options.processRunner.start({
          ...shimSpawn(spec.file, spec.args, spec.shell),
          cwd: spec.cwd,
        });
      } catch {
        notify({ status: 'spawn-failed' });
        return;
      }
      oneShots.add(handle);
      notify({ status: 'started', pid: handle.pid });
      handle.subscribeToStdout((line) => options.onLog(name, 'stdout', line));
      handle.subscribeToStderr((line) => options.onLog(name, 'stderr', line));
      void handle
        .waitForExit()
        .then(
          (exit) => {
            oneShots.delete(handle);
            return exit;
          },
          // The port promises never to reject. If one does anyway, the exit
          // is reported with neither code nor signal (the CLI words it "was
          // killed (unknown signal)"). The child may still be running, so its
          // handle stays in `oneShots` and `shutdown()` still kills it.
          () => ({ code: null, signal: null })
        )
        .then(({ code, signal }) => {
          // Ordered shutdown killed it: the session's doing, not news.
          if (shuttingDown) return;
          notify(
            signal === SPAWN_ERROR_SIGNAL
              ? { status: 'spawn-failed' }
              : { status: 'exited', code, signal }
          );
        });
    },

    /** Live status map keyed by graph node name (for the Studio source). */
    statuses(): Record<string, AppRuntimeStatus> {
      const map: Record<string, AppRuntimeStatus> = {};
      for (const app of managed) map[app.plan.name] = app.status;
      return map;
    },

    /**
     * F12: type one input line into the live child of one supervised app,
     * resolved by plan config key OR graph name (the same two handles the
     * status rows answer to). `line` is sent verbatim plus `\n` — the TUI
     * only ever sends complete lines. `false` when nothing received it: no
     * live child (never started, already exited, shutting down) or a handle
     * whose stdin is not writable.
     *
     * One-shot children are deliberately NOT routable: they are transient
     * (the `--launch` run exits when the app opens) and their handle is
     * tracked namelessly in `oneShots`; the CLI seam excludes the one-shot
     * row from the input path.
     *
     * CAVEAT (honest, mirrored in the TUI help): children spawn with piped
     * stdin, so the bytes DO reach the child process — but the react-native
     * CLI reads its interactive shortcuts (`r` reload etc.) only from a TTY
     * stdin. Watchers (esbuild/rspack) ignore stdin lines entirely; whether
     * anything reacts depends on the child actually reading stdin. This port
     * guarantees delivery to the pipe, not an effect.
     */
    writeAppInput(appKeyOrName: string, line: string): boolean {
      if (shuttingDown) return false;
      const app = managed.find(
        (candidate) =>
          candidate.plan.key === appKeyOrName ||
          candidate.plan.name === appKeyOrName
      );
      const handle = app?.handle;
      if (handle === null || handle === undefined) return false;
      if (handle.writeStdin === undefined) return false;
      return handle.writeStdin(`${line}\n`);
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
        const handles = [
          ...managed
            .map((app) => app.handle)
            .filter((handle): handle is ProcessHandle => handle !== null),
          ...oneShots,
        ];
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
  'ATLAS_APP_PLATFORM',
  'ATLAS_APP_STANDALONE',
] as const;

/** Re-export so consumers can type plans without importing core twice. */
export type DevFederationConfig = FederationConfig;
