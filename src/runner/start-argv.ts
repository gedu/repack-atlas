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
  if (input.config !== undefined) {
    const base = path.basename(input.config);
    if (base.startsWith('rspack')) return 'rspack';
    if (base.startsWith('webpack')) return 'webpack';
  }
  const present = new Set(input.files);
  if (RSPACK_CONFIG_FILES.some((file) => present.has(file))) return 'rspack';
  if (WEBPACK_CONFIG_FILES.some((file) => present.has(file))) return 'webpack';
  return 'rspack';
}

/** How the plan starts one app: a verbatim shell command or a built argv. */
export type DevLaunch =
  | { kind: 'command'; command: string }
  | {
      kind: 'argv';
      /** Executable; always `process.execPath` (PATH is never consulted). */
      file: string;
      /** Resolved `react-native` CLI script of THIS app. */
      cli: string;
      bundler: Bundler;
      /** Absolute bundler config; absent → the child's own discovery. */
      config?: string;
      platform?: 'ios' | 'android';
      standalone?: boolean;
    };

/**
 * The argv after `file` for an argv launch:
 * `<cli> start --bundler b [--config c] --port N --no-interactive
 * [--platform p] [--standalone]`. `port: null` is display-only (`<auto>`,
 * a `--dry-run` remote the runner has not allocated yet).
 */
export function startArgs(
  launch: Extract<DevLaunch, { kind: 'argv' }>,
  port: number | null
): string[] {
  const args = [launch.cli, 'start', '--bundler', launch.bundler];
  if (launch.config !== undefined) args.push('--config', launch.config);
  args.push('--port', port === null ? '<auto>' : String(port));
  // The supervisor owns stdin and signals: children are never interactive.
  args.push('--no-interactive');
  if (launch.platform !== undefined) args.push('--platform', launch.platform);
  if (launch.standalone === true) args.push('--standalone');
  return args;
}

const quote = (part: string): string =>
  /\s/.test(part) ? `"${part}"` : part;

/**
 * Readable one-line form for the plan table and `plan` event. A command
 * launch shows verbatim. An argv launch shows `node <cli> start ...` with the
 * CLI relative to `cwd` when it lives below it (stable across machines for
 * in-app installs) and absolute otherwise; `node` stands for `process.execPath`
 * so the JSON never embeds the node install path.
 */
export function describeLaunch(
  launch: DevLaunch,
  port: number | null,
  cwd: string
): string {
  if (launch.kind === 'command') return launch.command;
  const [cli, ...rest] = startArgs(launch, port);
  const relative = path.relative(cwd, cli!);
  const shownCli =
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : cli!;
  return ['node', shownCli, ...rest].map(quote).join(' ');
}
