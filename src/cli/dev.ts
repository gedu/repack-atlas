// `repack-atlas dev` (T9, docs/PRD.md §7.1/§7.2): argv → supervisor +
// Studio composition. This is the interactive-but-demo-grade runner: no
// wizard, no platforms, no launch — start what the workspace declares,
// prefix its logs, probe ports for readiness, serve the read-only Studio
// over the live graph, and shut everything down in order.
//
// `--json` event contract (PRD §7.1): one line per transition, each a single
// JSON object — `{event:'plan', apps}` once before anything spawns (`--dry-run`
// emits only this and `exit`), `{event:'studio', url}` once, `{event:'app', app, status,
// port}` per status transition, `{event:'exit', code}` last. Child log
// lines stay plain `[name]`-prefixed lines on stdout (same convention as
// upstream `federation-dev`): parse stdout line by line and keep only
// lines starting with `{`.

import {
  createManifestSource,
  createNodeProcessRunner,
  createNodeProjectFs,
  createWorkspaceConfigReader,
} from '../adapters/index.js';
import {
  createStudioServer,
  createWorkspaceGraphSource,
  firstFreeFrom,
} from '../studio/index.js';
import {
  createDevSupervisor,
  findPortConflicts,
  loadDevPlan,
  resolveDevPlan,
  type DevAppPlan,
  type DevPlanResult,
  type DevSkippedApp,
} from '../runner/supervisor.js';
import {
  formatPlanTable,
  toPlanEventApps,
  type DevPlanEventApp,
} from '../runner/plan.js';
import { lastValue, parseArgs, type ArgSpec } from './args.js';
import { DEV_HELP } from './help.js';

const EXIT_CLEAN = 0;
const EXIT_FOUND_ERRORS = 1;
const EXIT_NO_ANSWER = 2;

export const DEV_SPEC: ArgSpec = {
  valueOptions: ['apps'],
  optionalValueOptions: ['workspace', 'studio-port'],
  booleanFlags: ['json', 'ci', 'no-studio', 'dry-run', 'help'],
};

/** One line of the `--json` stream. Additive fields only. */
export type DevEvent =
  | { event: 'plan'; apps: DevPlanEventApp[] }
  | { event: 'studio'; url: string }
  | { event: 'app'; app: string; status: string; port: number; pid?: number }
  | { event: 'exit'; code: number };

export interface DevIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
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

/** Finding-like console note (honesty rule 7): skipped is not silent. */
function warnSkipped(skipped: DevSkippedApp[], io: DevIo): void {
  for (const skip of skipped) {
    io.writeErr(`dev: warning  ${skip.key}: no "command" declared — skipped`);
  }
}

interface DryRunInput {
  workspace: string;
  appNames: string[] | undefined;
  json: boolean;
  io: DevIo;
  emit(event: DevEvent): void;
  processRunner: ReturnType<typeof createNodeProcessRunner>;
  configReader: ReturnType<typeof createWorkspaceConfigReader>;
  manifestSource: ReturnType<typeof createManifestSource>;
}

/**
 * `--dry-run`: print the plan and exit. Declared ports are probed (never
 * bound) so a conflict is reported with exit 1; nothing spawns and the
 * Studio is not served. Output holds no timestamps or ephemeral ports, so
 * two runs on an unchanged workspace are byte-identical.
 */
async function runDryRun(input: DryRunInput): Promise<number> {
  const { io, emit } = input;
  const plan = await loadDevPlan({
    workspaceDir: input.workspace,
    configReader: input.configReader,
    manifestSource: input.manifestSource,
    ...(input.appNames !== undefined ? { apps: input.appNames } : {}),
  });
  if (!plan.ok) {
    for (const reason of plan.reasons) io.writeErr(`dev: ${reason}`);
    return EXIT_NO_ANSWER;
  }
  warnSkipped(plan.skipped, io);
  emit({ event: 'plan', apps: toPlanEventApps(plan.entries) });
  if (!input.json) io.writeOut(formatPlanTable(plan.entries));

  const conflicts = await findPortConflicts(plan.entries, input.processRunner);
  for (const conflict of conflicts) io.writeErr(`dev: ${conflict}`);
  const code = conflicts.length > 0 ? EXIT_FOUND_ERRORS : EXIT_CLEAN;
  emit({ event: 'exit', code });
  return code;
}

export async function runDevCommand(
  argv: string[],
  io: DevIo
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

  const appsFlag = lastValue(parsed, 'apps');
  const appNames =
    appsFlag !== undefined
      ? appsFlag
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '')
      : undefined;

  const emit = (event: DevEvent): void => {
    if (json) io.writeOut(JSON.stringify(event));
  };

  const processRunner = createNodeProcessRunner();
  const fs = createNodeProjectFs();
  const configReader = createWorkspaceConfigReader(fs);
  const manifestSource = createManifestSource(fs);

  if (parsed.flags.has('dry-run')) {
    return runDryRun({
      workspace,
      appNames,
      json,
      io,
      emit,
      processRunner,
      configReader,
      manifestSource,
    });
  }

  // 1. Plan. Nothing spawns before the whole plan resolves (upstream rule:
  // a port conflict fails naming the app, never a half-started session).
  const plan = await resolveDevPlan({
    workspaceDir: workspace,
    configReader,
    manifestSource,
    processRunner,
    ...(appNames !== undefined ? { apps: appNames } : {}),
  });
  if (!plan.ok) {
    for (const reason of plan.reasons) io.writeErr(`dev: ${reason}`);
    return EXIT_NO_ANSWER;
  }
  warnSkipped(plan.skipped, io);
  emit({ event: 'plan', apps: toPlanEventApps(plan.entries) });

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
  // SSE repaint, and (human mode) a one-line notice.
  const supervisor = createDevSupervisor({
    plan,
    processRunner,
    onLog(app, _stream, line) {
      io.writeOut(`[${app}] ${line}`);
    },
    onStatus(app, status, port, pid) {
      emit({
        event: 'app',
        app,
        status,
        port,
        ...(pid !== undefined ? { pid } : {}),
      });
      if (!json) io.writeOut(`dev: ${app} → ${status} (port ${port})`);
      void studio?.notify();
    },
  });
  supervisorRef.current = supervisor;

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
  const onKeydata = (chunk: Buffer): void => {
    const key = chunk.toString('utf8');
    // Raw mode bypasses the tty driver: Ctrl-C arrives as ETX, `q` quits,
    // `v`/`o` open the Studio URL in the platform browser.
    if (key === 'q' || key === '\u0003') requestShutdown();
    else if ((key === 'v' || key === 'o') && studio) {
      const url = studio.url();
      if (url) openInBrowser(url, processRunner, io);
    }
  };
  if (interactive) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKeydata);
  }

  try {
    if (!json) {
      const summary = plan.apps
        .map((app: DevAppPlan) => `${app.name}:${app.port}`)
        .join(' ');
      io.writeOut(
        `dev: supervising ${plan.apps.length} app(s)${summary ? ` (${summary})` : ''}`
      );
      if (interactive) {
        io.writeOut('keys: [v]/[o] open studio · [q] or Ctrl-C quit');
      }
    }
    await supervisor.start();
    await finished;
  } finally {
    if (interactive) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKeydata);
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  await supervisor.shutdown();
  await studio?.close();

  const code = supervisor.hasErrors() ? EXIT_FOUND_ERRORS : EXIT_CLEAN;
  emit({ event: 'exit', code });
  return code;
}

/** Exported for tests: the plan type without re-deriving it. */
export type ResolvedDevPlan = Extract<DevPlanResult, { ok: true }>;
