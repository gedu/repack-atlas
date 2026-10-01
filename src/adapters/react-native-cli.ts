// Node adapter for the `ReactNativeCliResolver` port. The CLI is resolved
// from the APP's own root with `createRequire` (AGENTS.md rule 4: user
// project resolution, never Atlas's own tree), following Node's upward
// `node_modules` walk and pnpm symlinks. PATH is never consulted and no other
// app's install can stand in. Mirrors upstream callstack/repack PR #1467
// `rnBin.ts` (`resolveReactNativeBin`): resolve `react-native/package.json`,
// then read `bin.react-native`; the script is run as `node <cli> start ...`
// because the `.bin` shim breaks under some pnpm layouts.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      ['-e', INSPECT_SCRIPT, configFile],
      {
        cwd: appRoot,
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
  } catch (error) {
    return {
      status: 'unknown',
      message: `loading ${configFile} failed: ${String(error).split('\n')[0]}`,
    };
  }
  const line = stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(OPTIONS_MARKER));
  if (line === undefined) {
    return {
      status: 'unknown',
      message: `${configFile} produced no start command report`,
    };
  }
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

/**
 * The `.bin/react-native` shim the app's package manager installed, found the
 * way Node finds packages (the app's `node_modules`, then each parent's).
 * Windows shims are `.cmd` files.
 */
function findBinShim(appRoot: string): string | undefined {
  const name = process.platform === 'win32' ? 'react-native.cmd' : 'react-native';
  let dir = path.resolve(appRoot);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (existsSync(candidate)) return candidate;
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
      const shim = findBinShim(appRoot);
      return {
        status: 'ok',
        cli: path.resolve(packageDir, bin),
        ...(shim !== undefined ? { shim } : {}),
      };
    },
    startOptions: inspectStartOptions,
  };
}
