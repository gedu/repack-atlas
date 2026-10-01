// Pure rules behind the default `react-native start` argv (ODD
// dev-wizard-runner T3): bundler detection and argv building. No I/O — the
// file listing and the resolved CLI path are handed in by `toolchain.ts`.
// Semantics follow callstack/repack PR #1467 (`detectBundler`,
// `devPlan.buildApp`), including its rspack default.

import path from 'node:path';

export type Bundler = 'rspack' | 'webpack';

/** App-root-relative config locations Re.Pack itself searches, per bundler. */
export const RSPACK_CONFIG_FILES = [
  'rspack.config.mts',
  'rspack.config.cts',
  'rspack.config.ts',
  'rspack.config.mjs',
  'rspack.config.cjs',
  'rspack.config.js',
] as const;

export const WEBPACK_CONFIG_FILES = [
  'webpack.config.mts',
  'webpack.config.cts',
  'webpack.config.ts',
  'webpack.config.mjs',
  'webpack.config.cjs',
  'webpack.config.js',
  '.webpack/webpack.config.mjs',
  '.webpack/webpack.config.cjs',
  '.webpack/webpack.config.js',
  '.webpack/webpackfile',
] as const;

export interface DetectBundlerInput {
  /** App-root-relative paths (posix separators) found in the app root. */
  files: readonly string[];
  /** The app's `config` field, when declared (only its file name is read). */
  config?: string;
}

/**
 * Pick the bundler for one app (upstream `detectBundler` precedence): the
 * declared `config` file name (`rspack*` / `webpack*`), else the config files
 * present in the app root, rspack first; with neither, rspack (Re.Pack's
 * default). A `config` named neither way falls through to the file check.
 */
export function detectBundler(input: DetectBundlerInput): Bundler {
  const named = bundlerFromConfigName(input.config);
  if (named !== undefined) return named;
  const present = new Set(input.files);
  if (RSPACK_CONFIG_FILES.some((file) => present.has(file))) return 'rspack';
  if (WEBPACK_CONFIG_FILES.some((file) => present.has(file))) return 'webpack';
  return 'rspack';
}

/**
 * The bundler a `config` field's file name alone decides (`rspack*` or
 * `webpack*`), or `undefined` when the name decides nothing.
 */
export function bundlerFromConfigName(
  config: string | undefined
): Bundler | undefined {
  if (config === undefined) return undefined;
  const base = path.basename(config);
  if (base.startsWith('rspack')) return 'rspack';
  if (base.startsWith('webpack')) return 'webpack';
  return undefined;
}

/** Executable shape of a resolved react-native CLI (shim preferred). */
export interface CliInvocation {
  file: string;
  /** Script to pass as first argument when running through `node`. */
  cli?: string;
  shell?: boolean;
}

/**
 * Quote one argument for a `.cmd` shim run through `cmd.exe` (the cross-spawn
 * algorithm): MSVCRT quoting first (backslashes before a quote doubled, `"`
 * -> `\"`, trailing backslashes doubled, wrap in quotes), then every cmd.exe
 * metacharacter caret-escaped. A `.cmd` shim re-parses its arguments through
 * `%*`, so the escaping is applied twice (`doubleEscape`).
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function quoteForCmd(arg: string, doubleEscape = true): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"');
  out = out.replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(CMD_META, '^$1');
  return doubleEscape ? out.replace(CMD_META, '^$1') : out;
}

/**
 * The spawn shape for a Windows `.cmd` shim: `cmd.exe /d /s /c "<line>"` with
 * verbatim arguments, every argument quoted by `quoteForCmd`, so a `--device`
 * or `--config` value can never inject a command. No `shell: true`.
 */
export function cmdShimSpawn(
  shim: string,
  args: readonly string[]
): { file: string; args: string[]; windowsVerbatimArguments: true } {
  const line = [shim.replace(CMD_META, '^$1'), ...args.map((a) => quoteForCmd(a))]
    .join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Prefer the app's package-manager shim (it exports the environment the CLI
 * needs, e.g. pnpm's NODE_PATH); fall back to `node <cli.js>` when the layout
 * has no shim. A Windows `.cmd` shim is flagged (`shell`) so the spawn goes
 * through `cmdShimSpawn` (cmd.exe with quoted arguments), never a raw shell.
 */
export function cliInvocation(resolved: {
  cli: string;
  shim?: string;
}): CliInvocation {
  if (resolved.shim === undefined) {
    return { file: process.execPath, cli: resolved.cli };
  }
  return {
    file: resolved.shim,
    ...(resolved.shim.toLowerCase().endsWith('.cmd') ? { shell: true } : {}),
  };
}

/** How the plan starts one app: a verbatim shell command or a built argv. */
export type DevLaunch =
  | { kind: 'command'; command: string }
  | {
      kind: 'argv';
      /** Executable: the app's `.bin/react-native` shim when it has one, else
       * `process.execPath` (PATH is never consulted). */
      file: string;
      /** Resolved `react-native` CLI script of THIS app; present only when
       * `file` is `node` (no shim), then it is the first argument. */
      cli?: string;
      /** A Windows `.cmd` shim: spawned via `cmdShimSpawn`, not directly. */
      shell?: boolean;
      /** Detected bundler: always shown, passed as `--bundler` only when the
       * installed `start` declares it (Re.Pack 5.x picks it from the app's
       * react-native config instead). */
      bundler: Bundler;
      /** Long flags the app's registered `start` declares; absent = could
       * not be determined (the safe path: no `--bundler`, no `--standalone`). */
      startOptions?: readonly string[];
      /** Why `startOptions` is absent (shown when it blocks a request). */
      startOptionsNote?: string;
      /** Absolute bundler config; absent → the child's own discovery. */
      config?: string;
      platform?: 'ios' | 'android';
      standalone?: boolean;
    };

/** Options only newer Re.Pack builds declare; never assumed when unknown. */
const OPT_IN_FLAGS: readonly string[] = ['--bundler', '--standalone'];

/**
 * Whether `flag` may be passed to the installed `start` command: declared
 * there, or (option set unknown) a long-standing option. `--bundler` and
 * `--standalone` need an explicit declaration.
 */
export function declaresStartOption(
  launch: Extract<DevLaunch, { kind: 'argv' }>,
  flag: string
): boolean {
  if (launch.startOptions === undefined) return !OPT_IN_FLAGS.includes(flag);
  return launch.startOptions.includes(flag);
}

/**
 * The argv after `file` for an argv launch:
 * `<cli> start [--bundler b] [--config c] --port N [--no-interactive]
 * [--platform p] [--standalone]`. Each option except `--port` is passed only
 * when the installed `start` declares it (published Re.Pack 5.x has no
 * `--bundler`/`--standalone`; callstack/repack PR #1467 adds them). `port:
 * null` is display-only (`<auto>`).
 */
export function startArgs(
  launch: Extract<DevLaunch, { kind: 'argv' }>,
  port: number | null
): string[] {
  const has = (flag: string): boolean => declaresStartOption(launch, flag);
  const args = launch.cli !== undefined ? [launch.cli, 'start'] : ['start'];
  if (has('--bundler')) args.push('--bundler', launch.bundler);
  if (launch.config !== undefined && has('--config')) {
    args.push('--config', launch.config);
  }
  args.push('--port', port === null ? '<auto>' : String(port));
  // The supervisor owns stdin and signals: children are never interactive.
  if (has('--no-interactive')) args.push('--no-interactive');
  if (launch.platform !== undefined && has('--platform')) {
    args.push('--platform', launch.platform);
  }
  if (launch.standalone === true && has('--standalone')) {
    args.push('--standalone');
  }
  return args;
}

/**
 * Readable form of a shim launch: the shim path relative to `cwd` when it
 * lives below it (`node_modules/.bin/react-native start ...`), absolute
 * otherwise (a hoisted workspace-root shim). The absolute form makes
 * `--dry-run --json` output machine-specific for hoisted installs.
 */
export function describeShim(
  file: string,
  args: readonly string[],
  cwd: string
): string {
  const relative = path.relative(cwd, file);
  const shown =
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : file;
  return [shown, ...args].map(quote).join(' ');
}

const quote = (part: string): string =>
  /\s/.test(part) ? `"${part}"` : part;

/**
 * Readable `node <script> ...` form of an argv whose first entry is a script
 * path (`process.execPath` is shown as `node`, so the JSON never embeds the
 * node install path). The script is shown relative to `cwd` when it lives
 * below it (stable across machines for in-app installs), absolute otherwise.
 */
export function describeArgv(args: readonly string[], cwd: string): string {
  const [script, ...rest] = args;
  const relative = path.relative(cwd, script!);
  const shown =
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : script!;
  return ['node', shown, ...rest].map(quote).join(' ');
}

/**
 * Readable one-line form for the plan table and `plan` event: a command
 * launch shows verbatim, an argv launch as `describeArgv` of its start argv.
 */
export function describeLaunch(
  launch: DevLaunch,
  port: number | null,
  cwd: string
): string {
  if (launch.kind === 'command') return launch.command;
  const args = startArgs(launch, port);
  return launch.cli !== undefined
    ? describeArgv(args, cwd)
    : describeShim(launch.file, args, cwd);
}
