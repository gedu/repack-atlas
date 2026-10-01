// Node adapter for the `ReactNativeCliResolver` port. The CLI is resolved
// from the APP's own root with `createRequire` (AGENTS.md rule 4: user
// project resolution, never Atlas's own tree), following Node's upward
// `node_modules` walk and pnpm symlinks. PATH is never consulted and no other
// app's install can stand in. Mirrors upstream callstack/repack PR #1467
// `rnBin.ts` (`resolveReactNativeBin`): resolve `react-native/package.json`,
// then read `bin.react-native`. The app's own `.bin/react-native` shim is
// reported too (when it belongs to this same react-native) and is what the
// runner spawns first: pnpm's shim exports the `NODE_PATH` the CLI needs. Only
// without a matching shim is the script run as `node <cli> start ...`.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  ReactNativeCliResolver,
  ReactNativeCliResult,
  StartOptionsResult,
} from '../core/ports.js';

/** React Native config files, in the CLI's own lookup order. */
const RN_CONFIG_FILES = [
  'react-native.config.js',
  'react-native.config.cjs',
  'react-native.config.mjs',
] as const;

const OPTIONS_MARKER = '__ATLAS_START_OPTIONS__';

// Runs in a child `node` with cwd = the app root, so the config (and the
// `@callstack/repack/commands/*` it requires) resolve from the USER project
// and any side effect or crash of that code stays out of Atlas's process.
// Requiring the commands module is cheap: Re.Pack 5.x defers rspack/webpack
// until a command actually runs (~0.1 s). Output is one marker line, so
// whatever the config prints cannot corrupt the result.
const INSPECT_SCRIPT = `
const { pathToFileURL } = require('node:url');
const file = process.argv[1];
(async () => {
  const loaded = file.endsWith('.mjs') ? await import(pathToFileURL(file).href) : require(file);
  const config = loaded && loaded.default && !loaded.commands ? loaded.default : loaded;
  const commands = Array.isArray(config && config.commands) ? config.commands : [];
  const start = commands.find((c) => c && c.name === 'start');
  const result = start
    ? { options: (start.options || []).map((o) => String(o && o.name)) }
    : { error: 'the config registers no "start" command' };
  process.stdout.write('\\n${OPTIONS_MARKER}' + JSON.stringify(result) + '\\n');
})().catch((e) => {
  process.stdout.write('\\n${OPTIONS_MARKER}' + JSON.stringify({ error: String(e && e.message || e) }) + '\\n');
});
`;

/** `--reset-cache, --resetCache` / `--port <number>` → every long flag. */
export function optionFlags(declared: string): string[] {
  return declared
    .split(',')
    .map((alias) => alias.trim().split(/\s+/)[0] ?? '')
    .filter((flag) => flag.startsWith('--'));
}

/** Inspection budget; `ATLAS_RN_INSPECT_TIMEOUT_MS` shortens it (tests). */
function inspectTimeoutMs(): number {
  const override = Number(process.env['ATLAS_RN_INSPECT_TIMEOUT_MS']);
  return Number.isFinite(override) && override > 0 ? override : 15_000;
}

function findReportLine(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(OPTIONS_MARKER));
}

function inspectStartOptions(root: string): StartOptionsResult {
  const appRoot = path.resolve(root);
  const configFile = RN_CONFIG_FILES.map((name) =>
    path.join(appRoot, name)
  ).find((file) => existsSync(file));
  if (configFile === undefined) {
    return {
      status: 'unknown',
      message: `no react-native.config.{js,cjs,mjs} in ${appRoot}`,
    };
  }
  const run = spawnSync(process.execPath, ['-e', INSPECT_SCRIPT, configFile], {
    cwd: appRoot,
    encoding: 'utf-8',
    timeout: inspectTimeoutMs(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = run.stdout ?? '';
  const reportLine = findReportLine(stdout);
  if (reportLine === undefined) {
    // No report at all: say why (spawn error, timeout, exit code or signal)
    // and quote the first stderr line.
    const stderrLine = (run.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '');
    const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
    const why =
      code === 'ETIMEDOUT'
        ? `timed out after ${inspectTimeoutMs() / 1000}s`
        : run.error !== undefined
          ? `could not run: ${run.error.message}`
          : run.signal !== null
            ? `was killed by ${run.signal}`
            : run.status !== 0
              ? `exited with code ${run.status}`
              : 'produced no start command report';
    return {
      status: 'unknown',
      message:
        `loading ${configFile} ${why}` +
        (stderrLine !== undefined ? `: ${stderrLine}` : ''),
    };
  }
  const line = reportLine;
  try {
    const parsed = JSON.parse(line.slice(OPTIONS_MARKER.length)) as {
      options?: unknown;
      error?: unknown;
    };
    if (Array.isArray(parsed.options)) {
      return {
        status: 'ok',
        options: [
          ...new Set(
            parsed.options.flatMap((name) => optionFlags(String(name)))
          ),
        ],
      };
    }
    return {
      status: 'unknown',
      message: `${configFile}: ${String(parsed.error ?? 'unreadable start command')}`,
    };
  } catch {
    return { status: 'unknown', message: `${configFile}: unreadable report` };
  }
}

const realpathOrSelf = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/**
 * Whether a `.bin/react-native` shim runs `cli`. npm/yarn shims are symlinks
 * to the script; pnpm shims are text files ending in
 * `# cmd-shim-target=<script>` (the `.cmd` form references
 * `%dp0%\..\react-native\cli.js`, the sh form `$basedir/../...`).
 */
function shimRunsCli(shim: string, cli: string): boolean {
  const want = realpathOrSelf(cli);
  if (realpathOrSelf(shim) === want) return true;
  let text: string;
  try {
    if (statSync(shim).size > 65_536) return false;
    text = readFileSync(shim, 'utf-8');
  } catch {
    return false;
  }
  const dir = path.dirname(shim);
  const targets: string[] = [];
  const marker = /cmd-shim-target=(.+)$/m.exec(text);
  if (marker?.[1] !== undefined) targets.push(marker[1].trim());
  for (const match of text.matchAll(
    /"(?:\$basedir|%dp0%|%~dp0)[\\/]([^"]+\.[cm]?js)"/g
  )) {
    targets.push(match[1]!.replace(/\\/g, '/'));
  }
  return targets.some(
    (target) => realpathOrSelf(path.resolve(dir, target)) === want
  );
}

/**
 * The `.bin/react-native` shim the app's package manager installed, found the
 * way Node finds packages (the app's `node_modules`, then each parent's).
 * Windows shims are `.cmd` files. A shim is used only when it runs the same
 * react-native script resolved from the app root: a hoisted `.bin` entry of a
 * different react-native version is skipped (the caller then runs
 * `node <cli>`).
 */
function findBinShim(appRoot: string, cli: string): string | undefined {
  const name = process.platform === 'win32' ? 'react-native.cmd' : 'react-native';
  let dir = path.resolve(appRoot);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (existsSync(candidate) && shimRunsCli(candidate, cli)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function createReactNativeCliResolver(): ReactNativeCliResolver {
  return {
    resolve(appRoot: string): ReactNativeCliResult {
      let packageJsonPath: string;
      try {
        packageJsonPath = createRequire(
          path.join(appRoot, 'package.json')
        ).resolve('react-native/package.json');
      } catch {
        return {
          status: 'failed',
          message:
            `cannot resolve the "react-native" package from ${appRoot} — ` +
            'each app runs with its own local react-native CLI; install it in the app',
        };
      }

      const packageDir = path.dirname(packageJsonPath);
      let bin: unknown;
      try {
        const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
          bin?: unknown;
        };
        bin =
          typeof manifest.bin === 'string'
            ? manifest.bin
            : (manifest.bin as Record<string, unknown> | undefined)?.[
                'react-native'
              ];
      } catch {
        bin = undefined;
      }
      if (typeof bin !== 'string' || bin === '') {
        return {
          status: 'failed',
          message:
            `the react-native package at ${packageDir} declares no ` +
            '"bin.react-native" script — it cannot be used to start an app',
        };
      }
      const cli = path.resolve(packageDir, bin);
      const shim = findBinShim(appRoot, cli);
      return {
        status: 'ok',
        cli,
        ...(shim !== undefined ? { shim } : {}),
      };
    },
    startOptions: inspectStartOptions,
  };
}
