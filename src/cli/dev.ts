// `repack-atlas dev` (T9, docs/PRD.md §7.1/§7.2): argv → supervisor +
// Studio composition. Start what the workspace declares (an explicit
// `command`, or the react-native start argv Atlas builds from `root`), chosen
// by flags or, on a TTY without `--apps`, by the interactive wizard
// (`dev-wizard.ts`; its answers feed the same plan inputs as the flags),
// prefix its logs, probe ports for readiness, serve the read-only Studio
// over the live graph, and shut everything down in order.
//
// `--json` event contract (PRD §7.1): one line per transition, each a single
// JSON object — `{event:'plan', apps}` once before anything spawns (`--dry-run`
// emits only this and `exit`; `--launch` adds a `launch` field), `{event:'studio',
// url}` once, `{event:'app', app, status, port}` per status transition,
// `{event:'launch', status:'started', pid?}` / `{event:'launch',
// status:'exited', code, signal?}` for the `--launch` one-shot (a spawn that
// never started reports `code: null, signal: 'spawn-error'`; a failure is
// reported, never the session's exit code),
// `{event:'exit', code}` last. Child log
// lines stay plain `[name]`-prefixed lines on stdout (same convention as
// upstream `federation-dev`): parse stdout line by line and keep only
// lines starting with `{`.
//
// Human TTY sessions render the ink dashboard (`dev-tui/`, mounted below
// right before supervision starts): a TUI failure never fails the session.
// Machine paths (`--json`, `--ci`, non-TTY, `--dry-run`) never import
// ink/react (AGENTS.md rule 11 exception (b)): the render layer is
// dynamic-imported inside the TUI gate only.

import {
  createManifestSource,
  createNodeProcessRunner,
  createNodeProjectFs,
  createPrompts,
  createReactNativeCliResolver,
  createWorkspaceConfigReader,
} from '../adapters/index.js';
import {
  createStudioServer,
  createWorkspaceGraphSource,
  firstFreeFrom,
} from '../studio/index.js';
import {
  createDevSupervisor,
  loadDevPlan,
  type OneShotEvent,
  resolveDevPlan,
  type DevAppPlan,
  type DevPlanResult,
  type DevPlanWarning,
  type DevSkippedApp,
} from '../runner/supervisor.js';
import {
  DEV_PLATFORMS,
  formatPlanTable,
  toPlanEventApps,
  type DevPlanEntry,
  type DevPlanEventApp,
  type DevPlatform,
} from '../runner/plan.js';
import {
  formatLaunchLine,
  LAUNCH_NEEDS_PLATFORM_REASON,
  toPlanEventLaunch,
  type DevPlanEventLaunch,
  type LaunchPlan,
} from '../runner/launch-plan.js';
import {
  allocatePorts,
  applyAssignments,
  describeReassignments,
  PORT_CONFLICT_HINT,
} from '../runner/ports.js';
import { type PromptPort } from '../core/index.js';
// The TUI view-model is PURE (no ink/react — model.ts holds the promise), so
// importing it statically keeps rule 11 exception (b) intact: only the ink
// render layer (`dev-tui/app.js` + `ink`/`react`) stays behind dynamic
// imports. tests/cli/dev-tui-seam.test.ts locks this file free of any
// top-level ink/react import.
import {
  createDevTuiModel,
  type DevTuiModel,
  type DevTuiRosterEntry,
} from './dev-tui/model.js';
// G4 startup banner: PURE like model.ts (no ink/react, no fs), so the static
// import keeps rule 11 exception (b) intact — dev-tui-seam.test.ts re-checks
// banner.ts for purity the same way it checks model.ts.
import { renderStartupBanner } from './dev-tui/banner.js';
import { readVersion } from './version.js';
import { lastValue, parseArgs, type ArgSpec } from './args.js';
import { runDevWizard, shouldRunWizard } from './dev-wizard.js';
import { DEV_HELP } from './help.js';

const EXIT_CLEAN = 0;
const EXIT_FOUND_ERRORS = 1;
const EXIT_NO_ANSWER = 2;

export const DEV_SPEC: ArgSpec = {
  valueOptions: ['apps', 'port', 'platform', 'standalone', 'device'],
  optionalValueOptions: ['workspace', 'studio-port'],
  booleanFlags: [
    'json',
    'ci',
    'no-interactive',
    'no-studio',
    'dry-run',
    'auto-ports',
    'launch',
    'no-launch',
    'help',
  ],
};

/** One line of the `--json` stream. Additive fields only. */
export type DevEvent =
  | { event: 'plan'; apps: DevPlanEventApp[]; launch?: DevPlanEventLaunch }
  | { event: 'studio'; url: string }
  | {
      event: 'app';
      app: string;
      status: string;
      port: number;
      pid?: number;
      /** Additive: the busy port `--auto-ports` moved this app away from. */
      reassignedFrom?: number;
    }
  | {
      event: 'launch';
      status: 'started' | 'exited';
      /** Exit code of the one-shot; `null` = killed by a signal / spawn error. */
      code?: number | null;
      pid?: number;
      signal?: string;
    }
  | { event: 'exit'; code: number };

export interface DevIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/** The terminal facts and prompt factory the wizard gate depends on. */
export interface DevEnv {
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  createPrompts(): Promise<PromptPort>;
  /**
   * Streams the ink wizard port renders to and reads keys from, when the TUI
   * prompt path is live (G5). Absent means the process streams — the real
   * terminal. Exists so the seam's TUI branch is testable without a pty.
   */
  promptStreams?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
}

const processDevEnv = (): DevEnv => ({
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  createPrompts: () => createPrompts(),
});

/** Launch needs exactly one platform (there is no `run-all`). */
const LAUNCH_NEEDS_PLATFORM = `dev: ${LAUNCH_NEEDS_PLATFORM_REASON}`;

/** The `{event:'plan'}` line shared by the dry-run and the live path. */
function planEvent(
  entries: DevPlanEntry[],
  launch: LaunchPlan | undefined
): DevEvent {
  return {
    event: 'plan',
    apps: toPlanEventApps(entries),
    ...(launch !== undefined ? { launch: toPlanEventLaunch(launch) } : {}),
  };
}

/** Platform opener for `v`/`o`; best-effort, never fails the session. */
function openInBrowser(
  url: string,
  processRunner: ReturnType<typeof createNodeProcessRunner>,
  io: DevIo
): void {
  const opener =
    process.platform === 'darwin'
      ? { file: 'open', args: [url], shell: false }
      : process.platform === 'win32'
        ? { file: `start "" "${url}"`, args: [], shell: true }
        : { file: 'xdg-open', args: [url], shell: false };
  try {
    // Nobody waits on the opener; it just needs to leave the URL open.
    const handle = processRunner.start(opener);
    void handle.waitForExit();
  } catch {
    io.writeErr(`dev: could not open the browser (${url})`);
  }
}

/**
 * Alt-screen enter + cursor hide, and the reverse (leave + cursor show).
 * ink 6 does NOT enter the alt screen itself, so the seam owns it: the
 * dashboard renders on a scratch screen and the plain shell output (plan
 * table, final messages) stays scrollback-untouched above it.
 */
const ALT_SCREEN_ENTER = '\u001b[?1049h\u001b[?25l';
const ALT_SCREEN_LEAVE = '\u001b[?25h\u001b[?1049l';

/**
 * G3 (crash path only): the mouse-tracking OFF decseq, duplicated from
 * `MOUSE_TRACKING_OFF` in `dev-tui/app.tsx`. dev.ts may NOT statically import
 * the ink render layer (the rule-11 fence in dev-tui-seam.test.ts), and the
 * crash handler must be synchronous, so a dynamic import is not an option
 * either. Keep the bytes in sync with app.tsx. On a normal unmount app.tsx's
 * own effect cleanup writes these; this is the belt-and-braces for the crash
 * path, where React effects never run. Writing it twice is harmless.
 */
const MOUSE_TRACKING_OFF = '\u001b[?1000l\u001b[?1006l';

/**
 * G3: while the TUI holds the screen, a crash must hand the terminal back
 * before the process dies. React effect cleanups do NOT run when an
 * uncaughtException / unhandledRejection kills the loop, so the emergency
 * path repeats everything the normal teardown does — unmount + cursor show +
 * alt-screen leave (the `teardown` closure `mountDevTui` returns), mouse
 * tracking off, stdin out of raw mode and paused — and THEN writes the error
 * to stderr through the plain io (after the alt-screen leave, so it lands on
 * the normal screen) and exits 1.
 *
 * `unhandledRejection` is fatal on the same path deliberately: Node's default
 * is a warning, and a warning nobody reads while the loop is half-dead and
 * the screen is still the alt screen is the worse outcome — an async crash
 * inside the TUI loop must not leave the terminal in that state.
 *
 * Returns a disarm function; call it from the normal finally so a clean
 * shutdown keeps its own exit code. Honest limits: SIGKILL or a fully
 * stalled event loop still leaves the terminal on the alt screen — inherent
 * to any alt-screen app (`reset`/`clear` recovers) — and `process.exit(1)`
 * skips the ordered supervisor shutdown, so children may outlive the crash;
 * a broken process is in no state to sequence their teardown anyway.
 */
function guardTerminalForCrash(
  teardown: () => void,
  io: DevIo
): () => void {
  const onFatal = (label: string, error: unknown): void => {
    // Remove the sibling handler first: teardown itself must never trip it.
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
    // Every step is best-effort: a broken stdin or stdout must not stop the
    // remaining restores (or the exit).
    try {
      process.stdout.write(MOUSE_TRACKING_OFF);
    } catch {
      /* stdout is gone; nothing left to write to */
    }
    try {
      teardown();
    } catch {
      /* the teardown already writes the leave sequence in its own finally */
    }
    try {
      if (process.stdin.isTTY === true && process.stdin.isRaw === true) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      /* stdin is gone too */
    }
    const reason =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      io.writeErr(`dev: ${label}: ${reason}`);
    } catch {
      /* stderr unavailable: the exit code is all that's left */
    }
    process.exit(1);
  };
  const onUncaughtException = (error: Error): void =>
    onFatal('uncaught exception', error);
  const onUnhandledRejection = (reason: unknown): void =>
    onFatal('unhandled rejection', reason);
  process.once('uncaughtException', onUncaughtException);
  process.once('unhandledRejection', onUnhandledRejection);
  return () => {
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  };
}

/** Swallows human output; used to keep `reportLaunch`'s emit path in the TUI. */
const NULL_IO: DevIo = { writeOut() {}, writeErr() {} };

/**
 * Mounts the ink dashboard (rule 11 exception (b)) for an interactive
 * session. ALL of ink/react/app.js is behind dynamic imports — a static
 * import here would load them on every machine path, so the TUI can only
 * ever cost startup time, never break `--json`/`--ci`/non-TTY (the contract
 * tests/cli/dev-tui-seam.test.ts locks by static analysis — the eslint
 * config has no ink/react rule, so that test is the fence).
 * `createElement` comes from react directly; app.js's emitted JSX (react-jsx
 * transform) pulls `react/jsx-runtime` through app.js itself.
 * Returns a teardown (unmount under the alt screen, then leave it), or `null`
 * when anything failed to load or render — the caller keeps plain output.
 * A dev session must never die because its render layer broke.
 */
async function mountDevTui(
  model: DevTuiModel,
  onQuit: () => void,
  onOpenStudio: (() => void) | undefined,
  io: DevIo,
  onSendInput: ((key: string, line: string) => boolean) | undefined
): Promise<(() => void) | null> {
  try {
    const { render } = await import('ink');
    const { createElement } = await import('react');
    const { DevTuiApp } = await import('./dev-tui/app.js');
    // Alt screen before render: ink's first frame lands on the scratch
    // screen. exitOnCtrlC:false keeps Ctrl-C flowing to onQuit.
    process.stdout.write(ALT_SCREEN_ENTER);
    try {
      const instance = render(
        createElement(DevTuiApp, {
          model,
          onQuit,
          ...(onOpenStudio !== undefined ? { onOpenStudio } : {}),
          ...(onSendInput !== undefined ? { onSendInput } : {}),
        }),
        { exitOnCtrlC: false }
      );
      return () => {
        // Unmount FIRST so ink's final frame paints under the alt screen,
        // then leave it: the shell prompt returns clean.
        try {
          instance.unmount();
        } finally {
          process.stdout.write(ALT_SCREEN_LEAVE);
        }
      };
    } catch (error) {
      // Render broke after we took the screen: give it back.
      process.stdout.write(ALT_SCREEN_LEAVE);
      throw error;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    io.writeErr(`dev: TUI unavailable (${reason}); using plain output`);
    return null;
  }
}

/**
 * Picks the wizard's `PromptPort` (G5). When the ink dashboard will mount, the
 * questions get the ink-rendered port so the wizard and the dashboard speak the
 * same visual language; the module and its ink/react imports are loaded ONLY
 * there (rule 11 exception (b)). A render-layer failure degrades to the
 * clack/readline prompts instead of killing the session — the same rule the
 * dashboard mount follows — because the wizard itself has no reason to fail
 * when the pretty renderer does.
 */
async function createWizardPrompts(
  tuiWillMount: boolean,
  env: DevEnv
): Promise<PromptPort> {
  if (!tuiWillMount) return env.createPrompts();
  try {
    const { createTuiPromptPort } = await import('./dev-tui/wizard.js');
    const streams = env.promptStreams;
    return createTuiPromptPort(
      streams === undefined
        ? {}
        : { stdin: streams.stdin, stdout: streams.stdout }
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `dev: wizard TUI prompts unavailable (${reason}); using plain prompts\n`
    );
    return env.createPrompts();
  }
}

/** Finding-like console note (honesty rule 7): skipped is not silent. */
function warnSkipped(skipped: DevSkippedApp[], io: DevIo): void {
  for (const skip of skipped) {
    io.writeErr(`dev: warning  ${skip.key}: ${skip.reason}`);
  }
}

/** Same note for assumptions made on apps that do run (e.g. a guessed bundler). */
function warnAssumptions(warnings: DevPlanWarning[], io: DevIo): void {
  for (const warning of warnings) {
    io.writeErr(`dev: warning  ${warning.key}: ${warning.message}`);
  }
}

interface DryRunInput {
  workspace: string;
  appNames: string[] | undefined;
  hostPort: number | undefined;
  platform: DevPlatform | undefined;
  standalone: string | undefined;
  launch: { device?: string } | undefined;
  ports: Record<string, number> | undefined;
  autoPorts: boolean;
  json: boolean;
  io: DevIo;
  emit(event: DevEvent): void;
  processRunner: ReturnType<typeof createNodeProcessRunner>;
  configReader: ReturnType<typeof createWorkspaceConfigReader>;
  manifestSource: ReturnType<typeof createManifestSource>;
  fs: ReturnType<typeof createNodeProjectFs>;
  reactNativeCli: ReturnType<typeof createReactNativeCliResolver>;
}

/**
 * `--dry-run`: print the plan and exit. Declared ports are probed (never
 * bound): every conflict is reported together with exit 1, or reassigned
 * with `--auto-ports`. Nothing spawns and the Studio is not served. Apps
 * without a port stay `auto`, so without `--auto-ports` (or with no busy
 * port) the output holds no timestamps or ephemeral ports and two runs on an
 * unchanged workspace are byte-identical.
 */
async function runDryRun(input: DryRunInput): Promise<number> {
  const { io, emit } = input;
  const plan = await loadDevPlan({
    workspaceDir: input.workspace,
    configReader: input.configReader,
    manifestSource: input.manifestSource,
    fs: input.fs,
    reactNativeCli: input.reactNativeCli,
    ...(input.appNames !== undefined ? { apps: input.appNames } : {}),
    ...(input.hostPort !== undefined ? { hostPort: input.hostPort } : {}),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.standalone !== undefined ? { standalone: input.standalone } : {}),
    ...(input.launch !== undefined ? { launch: input.launch } : {}),
    ...(input.ports !== undefined ? { ports: input.ports } : {}),
  });
  if (!plan.ok) {
    for (const reason of plan.reasons) io.writeErr(`dev: ${reason}`);
    return EXIT_NO_ANSWER;
  }
  warnSkipped(plan.skipped, io);
  warnAssumptions(plan.warnings, io);

  const allocation = await allocatePorts(plan.entries, input.processRunner, {
    autoPorts: input.autoPorts,
    resolveAuto: false,
  });
  // Conflicts still print the declared plan so the table shows what clashed.
  const shown = allocation.ok
    ? applyAssignments(plan.entries, allocation.assignments)
    : plan.entries;
  emit(planEvent(shown, plan.launch));
  if (!input.json) {
    io.writeOut(formatPlanTable(shown));
    if (plan.launch !== undefined) io.writeOut(formatLaunchLine(plan.launch));
  }

  let code = EXIT_CLEAN;
  if (allocation.ok) {
    if (!input.json) {
      for (const note of describeReassignments(allocation.assignments)) {
        io.writeErr(`dev: ${note}`);
      }
    }
  } else {
    for (const conflict of allocation.conflicts) io.writeErr(`dev: ${conflict}`);
    io.writeErr(`dev: ${PORT_CONFLICT_HINT}`);
    code = EXIT_FOUND_ERRORS;
  }
  emit({ event: 'exit', code });
  return code;
}

/** Signal the `--json` launch event carries for a child that never spawned. */
const SPAWN_ERROR_JSON_SIGNAL = 'spawn-error';

/**
 * Report the `--launch` one-shot. Non-zero exit and spawn errors are loud on
 * stderr (and as a `--json` event) but the session continues: servers keep serving and
 * the exit code still reflects the apps only.
 */
function reportLaunch(
  name: string,
  result: OneShotEvent,
  emit: (event: DevEvent) => void,
  io: DevIo,
  json: boolean
): void {
  if (result.status === 'started') {
    emit({
      event: 'launch',
      status: 'started',
      ...(result.pid !== null ? { pid: result.pid } : {}),
    });
    if (!json) io.writeOut(`dev: ${name} → started`);
    return;
  }
  if (result.status === 'spawn-failed') {
    // The `--json` contract keeps reporting a failed spawn as an exit with
    // this signal (additive-only events), whatever the supervisor's shape.
    emit({
      event: 'launch',
      status: 'exited',
      code: null,
      signal: SPAWN_ERROR_JSON_SIGNAL,
    });
    io.writeErr(`dev: ${name} could not be spawned; the session keeps serving`);
    return;
  }
  emit({
    event: 'launch',
    status: 'exited',
    code: result.code,
    ...(result.signal !== null ? { signal: result.signal } : {}),
  });
  if (result.code === 0) {
    if (!json) io.writeOut(`dev: ${name} → exited (app launched)`);
  } else {
    // stderr in both modes (like the skipped-app warnings): never the
    // `--json` stdout stream, never the exit code.
    const how =
      result.code !== null
        ? `exited with code ${result.code}`
        : `was killed (${result.signal ?? 'unknown signal'})`;
    io.writeErr(`dev: ${name} ${how}; the session keeps serving`);
  }
}

export async function runDevCommand(
  argv: string[],
  io: DevIo,
  env: DevEnv = processDevEnv()
): Promise<number> {
  const parsed = parseArgs(argv, DEV_SPEC);
  if (parsed.flags.has('help')) {
    io.writeOut(DEV_HELP);
    return EXIT_CLEAN;
  }
  if (parsed.error) {
    io.writeErr(`dev: ${parsed.error}`);
    io.writeErr(DEV_HELP);
    return EXIT_NO_ANSWER;
  }
  if (parsed.positional.length > 0) {
    io.writeErr(`dev: unexpected argument ${parsed.positional[0]}`);
    io.writeErr(DEV_HELP);
    return EXIT_NO_ANSWER;
  }

  const json = parsed.flags.has('json');
  const ci = parsed.flags.has('ci');
  const useStudio = !parsed.flags.has('no-studio');
  const workspace = lastValue(parsed, 'workspace') ?? process.cwd();

  // G4 startup banner: HUMAN runs only. The condition is exactly
  // `!json && !ci && env.stdoutIsTTY` — machine paths (--json, --ci,
  // --no-interactive, a piped stdout) print NOTHING new. It sits on the
  // normal screen, before the wizard and the plan table, so the alt-screen
  // TUI can never cover it. The version comes from the shared reader
  // (src/cli/version.ts); a failure there must not sink the banner, so it
  // renders without the version line in that case. Color follows the
  // standard NO_COLOR convention on top of the TTY gate.
  if (!json && !ci && env.stdoutIsTTY) {
    const version = await readVersion().catch(() => '');
    const banner = renderStartupBanner({
      version,
      columns: process.stdout.columns ?? 80,
      color: process.env.NO_COLOR === undefined,
    });
    // Empty below BANNER_MIN_COLUMNS: print nothing, not even a blank line.
    if (banner !== '') io.writeOut(banner);
  }

  let studioPort: number | undefined;
  if (parsed.options.has('studio-port')) {
    const raw = lastValue(parsed, 'studio-port');
    if (raw === undefined) {
      io.writeErr('dev: --studio-port requires a value');
      return EXIT_NO_ANSWER;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 65_535) {
      io.writeErr('dev: --studio-port must be a TCP port number (0-65535)');
      return EXIT_NO_ANSWER;
    }
    studioPort = value;
  }

  let hostPort: number | undefined;
  if (parsed.options.has('port')) {
    const raw = lastValue(parsed, 'port');
    // Plain decimal digits only: Number() would also take '0x50', '1e3', ' 80'.
    const value = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      io.writeErr('dev: --port must be a TCP port number (1-65535)');
      return EXIT_NO_ANSWER;
    }
    hostPort = value;
  }
  const autoPorts = parsed.flags.has('auto-ports');

  let platform: DevPlatform | undefined;
  if (parsed.options.has('platform')) {
    const raw = lastValue(parsed, 'platform');
    platform = DEV_PLATFORMS.find((candidate) => candidate === raw);
    if (platform === undefined) {
      io.writeErr(
        `dev: --platform must be one of: ${DEV_PLATFORMS.join(', ')} (got ${JSON.stringify(raw)})`
      );
      return EXIT_NO_ANSWER;
    }
  }

  // Whether the remote exists and declares `standalone: true` needs the
  // config, so that gate lives in the plan (same exit 2, nothing spawned).
  let standalone: string | undefined;
  if (parsed.options.has('standalone')) {
    standalone = lastValue(parsed, 'standalone')?.trim();
    if (standalone === undefined || standalone === '') {
      io.writeErr('dev: --standalone requires a remote name');
      return EXIT_NO_ANSWER;
    }
  }

  // Upstream parity: launching needs exactly one platform (there is no
  // `run-all`), and the two launch flags are opposites. Both are usage errors
  // before anything is read or spawned. Without `--launch` nothing launches
  // unless the wizard asks and the user agrees; `--device` alone is ignored.
  const wantLaunch = parsed.flags.has('launch');
  if (wantLaunch && parsed.flags.has('no-launch')) {
    io.writeErr('dev: --launch and --no-launch cannot be combined');
    return EXIT_NO_ANSWER;
  }
  if (wantLaunch && platform === undefined) {
    io.writeErr(LAUNCH_NEEDS_PLATFORM);
    return EXIT_NO_ANSWER;
  }
  const appsFlag = lastValue(parsed, 'apps');
  const wizard = shouldRunWizard({
    hasApps: appsFlag !== undefined,
    noInteractive: parsed.flags.has('no-interactive') || ci,
    json,
    stdoutIsTTY: env.stdoutIsTTY,
    stdinIsTTY: env.stdinIsTTY,
  });
  const device = lastValue(parsed, 'device');
  if (device !== undefined && !wantLaunch && !wizard) {
    io.writeErr('dev: warning  --device is ignored without --launch');
  }
  let launch: { device?: string } | undefined = wantLaunch
    ? { ...(device !== undefined ? { device } : {}) }
    : undefined;

  let appNames =
    appsFlag !== undefined
      ? appsFlag
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '')
      : undefined;

  const emit = (event: DevEvent): void => {
    if (json) io.writeOut(JSON.stringify(event));
  };

  // One ink session for the whole human session, two screens: the wizard
  // prompts render on the NORMAL screen (below the G4 banner), the dashboard
  // takes the alt screen later. Both mount on the SAME condition, computed
  // once here and reused at the dashboard gate below, so the two can never
  // disagree about who owns the terminal. `env.stdoutIsTTY` (not process) and
  // the `process.stdin.isTTY` the dashboard gate already used keep the gate
  // injectable exactly as before.
  const tuiCondition =
    !ci && !json && Boolean(process.stdin.isTTY) && env.stdoutIsTTY;

  const processRunner = createNodeProcessRunner();
  const fs = createNodeProjectFs();
  const configReader = createWorkspaceConfigReader(fs);
  const manifestSource = createManifestSource(fs);
  const reactNativeCli = createReactNativeCliResolver();

  // Wizard: an input source only. Its answers replace the flag values of the
  // same inputs, then everything below is the one shared path.
  let portOverrides: Record<string, number> | undefined;
  if (wizard) {
    const first = await loadDevPlan({
      workspaceDir: workspace,
      configReader,
      manifestSource,
      fs,
      reactNativeCli,
      ...(hostPort !== undefined ? { hostPort } : {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(standalone !== undefined ? { standalone } : {}),
    });
    if (!first.ok) {
      for (const reason of first.reasons) io.writeErr(`dev: ${reason}`);
      return EXIT_NO_ANSWER;
    }
    // G5 "wizard-in-TUI": when the dashboard WILL mount, the questions get the
    // ink prompt port — the dashboard's visual language on the NORMAL screen,
    // one session for the whole wizard (dynamic import: ink/react stay off
    // every machine path, rule 11 exception (b)). Anything else keeps the
    // clack/readline prompts exactly as before. Like the dashboard mount, a
    // render-layer failure degrades instead of killing the session: the wizard
    // still asks the same questions through `env.createPrompts()`. The wizard
    // flow, its answers, and everything downstream are identical either way.
    const prompts = await createWizardPrompts(tuiCondition, env);
    let outcome;
    try {
      outcome = await runDevWizard(prompts, {
        entries: first.entries,
        standaloneRemotes: first.standaloneRemotes,
        ...(platform !== undefined ? { platform } : {}),
        ...(wantLaunch
          ? { launch: true }
          : parsed.flags.has('no-launch')
            ? { launch: false }
            : {}),
      });
    } finally {
      prompts.close();
    }
    // Cancel is a clean no-op, not a failure: nothing was spawned.
    if (outcome.status === 'cancelled') return EXIT_CLEAN;
    const { answers } = outcome;
    appNames = answers.apps;
    platform = answers.platform;
    standalone = answers.standalone ?? standalone;
    portOverrides = answers.ports;
    if (answers.launch !== undefined) {
      launch = answers.launch
        ? { ...(device !== undefined ? { device } : {}) }
        : undefined;
    }
    if (launch !== undefined && platform === undefined) {
      io.writeErr(LAUNCH_NEEDS_PLATFORM);
      return EXIT_NO_ANSWER;
    }
  }

  if (parsed.flags.has('dry-run')) {
    return runDryRun({
      workspace,
      appNames,
      hostPort,
      platform,
      standalone,
      launch,
      ports: portOverrides,
      autoPorts,
      json,
      io,
      emit,
      processRunner,
      configReader,
      manifestSource,
      fs,
      reactNativeCli,
    });
  }

  // 1. Plan. Nothing spawns before the whole plan resolves (upstream rule:
  // a port conflict fails naming the app, never a half-started session).
  const plan = await resolveDevPlan({
    workspaceDir: workspace,
    configReader,
    manifestSource,
    processRunner,
    fs,
    reactNativeCli,
    autoPorts,
    ...(appNames !== undefined ? { apps: appNames } : {}),
    ...(hostPort !== undefined ? { hostPort } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(standalone !== undefined ? { standalone } : {}),
    ...(launch !== undefined ? { launch } : {}),
    ...(portOverrides !== undefined ? { ports: portOverrides } : {}),
  });
  if (!plan.ok) {
    for (const reason of plan.reasons) io.writeErr(`dev: ${reason}`);
    // Busy ports ran-and-found-errors (1, dry-run parity); the rest is 2.
    return plan.portConflict ? EXIT_FOUND_ERRORS : EXIT_NO_ANSWER;
  }
  warnSkipped(plan.skipped, io);
  warnAssumptions(plan.warnings, io);
  if (!json) {
    for (const note of plan.reassignments) io.writeErr(`dev: ${note}`);
  }
  // The plan event carries the final (allocated) ports, auto ones included.
  emit(planEvent(plan.entries, plan.launch));

  // 2. Studio before spawning: its bind failure must not orphan children.
  const supervisorRef: { current: ReturnType<typeof createDevSupervisor> | null } =
    { current: null };
  const graphSource = createWorkspaceGraphSource({
    workspaceDir: plan.configDir,
    configReader,
    manifestSource,
    statuses: () => supervisorRef.current?.statuses() ?? {},
  });
  let studio: ReturnType<typeof createStudioServer> | null = null;
  if (useStudio) {
    const port =
      studioPort !== undefined
        ? studioPort
        : await firstFreeFrom(8_099).catch(() => null);
    if (port === null) {
      io.writeErr('dev: no free studio port at or above 8099');
      return EXIT_NO_ANSWER;
    }
    studio = createStudioServer({
      ...graphSource,
      studioPort: port,
      onError: (error, context) =>
        io.writeErr(`dev: studio ${context}: ${String(error)}`),
    });
    try {
      await studio.listen();
    } catch (error) {
      io.writeErr(
        `dev: studio could not listen on port ${port}: ${String(error)}`
      );
      return EXIT_NO_ANSWER;
    }
    const url = studio.url()!;
    emit({ event: 'studio', url });
    if (!json) io.writeOut(`Federation Studio (read-only): ${url}`);
  }

  // 3. Supervisor. Status transitions fan out to: the --json stream, an
  // SSE repaint, and (human mode) a one-line notice — or the TUI dashboard
  // for a human at a real terminal (see the gate below).
  //
  // TUI gate (rule 11 exception (b)): the SAME human-interactive condition
  // as the key handling (`interactive`: no --ci, no --json, TTY stdin) PLUS
  // TTY stdout, reached only on the live plan path after the wizard closed
  // and the plan/warnings/studio-URL lines printed. `env.stdoutIsTTY` (not
  // process) keeps the gate injectable for tests. G5 hoisted the expression to
  // `tuiCondition` above so the wizard's prompt port and the dashboard are
  // decided by ONE condition. The roster mirrors `plan.apps` in plan order
  // (buildDevPlan puts the host first); rows answer to key AND graph name,
  // which is what the supervisor emits.
  const tuiModel = tuiCondition
      ? createDevTuiModel({
          apps: plan.apps.map(
            (app): DevTuiRosterEntry => ({
              key: app.key,
              name: app.name,
              role: app.role,
              port: app.port,
              ...(app.reassignedFrom !== undefined
                ? { reassignedFrom: app.reassignedFrom }
                : {}),
            })
          ),
          ...(plan.launch !== undefined ? { launchName: 'launch' } : {}),
        })
      : null;
  // Flip to true only once ink actually rendered; the hooks below branch on
  // it (they can only fire after `start()`, well after the mount attempt).
  let tuiActive = false;
  const supervisor = createDevSupervisor({
    plan,
    processRunner,
    onLog(app, stream, line) {
      if (tuiActive) {
        tuiModel?.log(app, stream, line, Date.now());
      } else {
        io.writeOut(`[${app}] ${line}`);
      }
    },
    onStatus(app, status, port, pid) {
      const reassignedFrom = plan.apps.find(
        (candidate) => candidate.name === app
      )?.reassignedFrom;
      emit({
        event: 'app',
        app,
        status,
        port,
        ...(pid !== undefined ? { pid } : {}),
        ...(reassignedFrom !== undefined ? { reassignedFrom } : {}),
      });
      if (tuiActive) {
        // The sidebar row replaces the one-line notice; --json above and the
        // SSE repaint below are unchanged.
        tuiModel?.status(app, status, port, pid);
      } else if (!json) {
        io.writeOut(`dev: ${app} → ${status} (port ${port})`);
      }
      void studio?.notify();
    },
    onOneShot(name, result) {
      if (tuiActive) {
        // Keep the emit path EXACTLY (the --json launch events); route the
        // one-shot row's status through the model instead of reportLaunch's
        // human lines — the sidebar already shows started/exited/error via
        // oneShot, so its plain/notice lines would be noise on the alt
        // screen.
        reportLaunch(name, result, emit, NULL_IO, json);
        tuiModel?.oneShot(name, result);
        return;
      }
      reportLaunch(name, result, emit, io, json);
    },
  });
  supervisorRef.current = supervisor;
  // The launch fires once, on the target's first `ready`; a failure is only
  // ever reported (see `reportLaunch`), never the session's exit code.
  if (plan.launch !== undefined) {
    const { file, args, cwd, shell } = plan.launch;
    supervisor.onFirstReady(plan.launch.triggerKey, () =>
      supervisor.spawnOneShot('launch', {
        file,
        args,
        cwd,
        ...(shell === true ? { shell } : {}),
      })
    );
  }

  // 4. Shutdown plumbing: q / Ctrl-C / SIGTERM → ordered shutdown, once.
  let resolveFinished: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let shuttingDown = false;
  function requestShutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    resolveFinished?.();
  }

  const onSigint = (): void => requestShutdown();
  const onSigterm = (): void => requestShutdown();
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // Keys only on a real TTY without --json/--ci; non-TTY (CI, pipes)
  // degrades to signal-driven shutdown with no stdin tampering.
  const interactive = !ci && !json && Boolean(process.stdin.isTTY);
  const openStudio = (): void => {
    if (!studio) return;
    const url = studio.url();
    if (url) openInBrowser(url, processRunner, io);
  };
  // The raw-mode key handler serves the PLAIN interactive rendering only.
  // When the TUI mounts, ink's useInput owns stdin raw mode entirely (it
  // setRawMode(true) on mount and restores on unmount) and its own keys
  // (q/Ctrl-C → onQuit, v/o → onOpenStudio) replace these — double-managing
  // raw mode or double-listening would fight over every keystroke.
  const onKeydata = (chunk: Buffer): void => {
    const key = chunk.toString('utf8');
    // Raw mode bypasses the tty driver: Ctrl-C arrives as ETX, `q` quits,
    // `v`/`o` open the Studio URL in the platform browser.
    if (key === 'q' || key === '\u0003') requestShutdown();
    else if ((key === 'v' || key === 'o') && studio) openStudio();
  };
  // With the TUI mounting, stdin state must be clean before ink takes it:
  // the wizard's PromptPort is closed by now (clack restores raw mode and
  // shows the cursor when a question settles; readline closes its interface
  // and never touched raw mode), so the seam only pauses the stream here —
  // ink refs/reuses stdin itself.
  const tuiWillMount = tuiModel !== null;
  let plainKeysAttached = false;
  const attachPlainKeys = (): void => {
    plainKeysAttached = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKeydata);
  };
  if (interactive && !tuiWillMount) attachPlainKeys();
  else if (tuiWillMount) process.stdin.pause();

  let teardownTui: (() => void) | null = null;
  // G3: armed once ink actually rendered, disarmed in the finally below.
  // While armed, a crash restores the terminal before exiting (see
  // guardTerminalForCrash).
  let disarmCrashGuard: (() => void) | null = null;
  try {
    if (!json) {
      const summary = plan.apps
        .map((app: DevAppPlan) => `${app.name}:${app.port}`)
        .join(' ');
      io.writeOut(
        `dev: supervising ${plan.apps.length} app(s)${summary ? ` (${summary})` : ''}`
      );
      if (interactive && !tuiWillMount) {
        io.writeOut('keys: [v]/[o] open studio · [q] or Ctrl-C quit');
      }
    }
    if (tuiWillMount) {
      // Mount after the supervising/keys lines (they belong to the normal
      // screen and scroll away with the alt screen anyway — fine) and right
      // before `start()`, so no child output races the first frame.
      //
      // F12 typed input: routes the TUI's line to the selected app's live
      // child stdin through the supervisor (which resolves by plan key OR
      // graph name and only ever reaches a supervised app). The one-shot
      // `launch` row is not routable — its child is transient and the
      // supervisor never resolves it, so `writeAppInput('launch', …)`
      // returns false; the TUI additionally disables input on a `oneshot`
      // row so the key never looks like it did nothing.
      //
      // CAVEAT (why the help text only promises "send line to app stdin"):
      // children spawn with PIPED stdin, so the bytes do reach the child
      // process — but the react-native CLI reads its interactive shortcuts
      // (`r` reload etc.) only from a TTY stdin. Watchers (esbuild/rspack)
      // ignore stdin entirely. Delivery to the pipe is guaranteed; an effect
      // on the child is not, and nothing here claims otherwise.
      teardownTui = await mountDevTui(
        tuiModel,
        requestShutdown,
        studio ? openStudio : undefined,
        io,
        (key, line) => supervisor.writeAppInput(key, line)
      );
      tuiActive = teardownTui !== null;
      if (teardownTui !== null) {
        disarmCrashGuard = guardTerminalForCrash(teardownTui, io);
      }
      if (!tuiActive && interactive) {
        // TUI broke: degrade to today's plain interactive rendering —
        // warning already written by mountDevTui — so re-attach the plain
        // keys the mount attempt had suppressed.
        if (!json) {
          io.writeOut('keys: [v]/[o] open studio · [q] or Ctrl-C quit');
        }
        attachPlainKeys();
      }
    }
    await supervisor.start();
    await finished;
  } finally {
    // Order: TUI teardown FIRST (unmount paints its final frame under the
    // alt screen, then the alt-screen leave restores the shell screen),
    // then the plain-mode stdin teardown, then the signal handlers. Hooks
    // still firing after teardown (shutdown statuses) write to the model —
    // harmless — and keep emitting --json; nothing prints to the screen.
    try {
      // G3: disarm FIRST — this is the clean path; the session's own exit
      // code must survive, and the guard's exit(1) would override it.
      disarmCrashGuard?.();
      teardownTui?.();
    } finally {
      if (plainKeysAttached) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKeydata);
      }
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }

  await supervisor.shutdown();
  await studio?.close();

  const code = supervisor.hasErrors() ? EXIT_FOUND_ERRORS : EXIT_CLEAN;
  emit({ event: 'exit', code });
  return code;
}

/** Exported for tests: the plan type without re-deriving it. */
export type ResolvedDevPlan = Extract<DevPlanResult, { ok: true }>;
