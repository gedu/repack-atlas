// Per-app toolchain resolution for the default argv (ODD dev-wizard-runner
// T3): the two facts `buildDevPlan` cannot compute purely — which bundler
// config files sit in the app root (ProjectFs) and where the app's own
// `react-native` CLI lives (ReactNativeCliResolver). Both are read through
// core-owned ports; the decisions stay in `start-argv.ts`.

import path from 'node:path';
import type {
  ProjectFs,
  ReactNativeCliResolver,
} from '../core/index.js';
import {
  bundlerFromConfigName,
  detectBundler,
  RSPACK_CONFIG_FILES,
  WEBPACK_CONFIG_FILES,
  type Bundler,
} from './start-argv.js';

export type ToolchainResolution =
  | {
      ok: true;
      bundler: Bundler;
      cli: string;
      /** The app's `.bin/react-native` shim, when it has one. */
      shim?: string;
      /** Set when the bundler is a guess: the app root could not be read, so
       * rspack (Re.Pack's default) was assumed. */
      bundlerNote?: string;
      /** Options the app's `start` declares; absent = undetermined. */
      startOptions?: readonly string[];
      /** Why `startOptions` is absent. */
      startOptionsNote?: string;
    }
  | { ok: false; reason: string };

/**
 * Key of one resolution. The bundler depends on the app's `config` field as
 * well as its root, so two apps sharing a root (a monorepo root hosting two
 * bundler configs) must not share an entry.
 */
export function toolchainKey(root: string, config?: string): string {
  return config === undefined ? root : `${root}\u0000${config}`;
}

/** `toolchainKey` → its resolved toolchain (or why it has none). */
export type Toolchains = Readonly<Record<string, ToolchainResolution>>;

/** Root-relative posix paths of the bundler config files present in `root`. */
async function listConfigFiles(fs: ProjectFs, root: string): Promise<string[]> {
  const top = new Set(await fs.readdir(root));
  const webpackDir = new Set(await fs.readdir(path.join(root, '.webpack')));
  return [...RSPACK_CONFIG_FILES, ...WEBPACK_CONFIG_FILES].filter((file) =>
    file.startsWith('.webpack/')
      ? webpackDir.has(file.slice('.webpack/'.length))
      : top.has(file)
  );
}


export interface ToolchainTarget {
  /** Absolute app root. */
  root: string;
  /** The app's `config` field, when declared. */
  config?: string;
}

/**
 * Resolve the bundler and react-native CLI for every target root. Never
 * throws; a root without a resolvable CLI carries its reason.
 */
export async function resolveToolchains(
  targets: ToolchainTarget[],
  deps: { fs: ProjectFs; reactNativeCli: ReactNativeCliResolver }
): Promise<Toolchains> {
  const resolved: Record<string, ToolchainResolution> = {};
  for (const target of targets) {
    const key = toolchainKey(target.root, target.config);
    // Apps with the same root and config resolve once.
    if (key in resolved) continue;
    // `ProjectFs` encodes "cannot list" as `[]`, never a throw, so an
    // unreadable root is told apart by statting it first. Without a listing
    // the bundler is a guess (rspack) unless `config` already decides it.
    let files: string[] = [];
    let unreadableRoot = false;
    const rootStat = await deps.fs.stat(target.root);
    if (rootStat === null || !rootStat.isDirectory) {
      unreadableRoot = true;
    } else {
      files = await listConfigFiles(deps.fs, target.root);
    }
    const bundler = detectBundler({
      files,
      ...(target.config !== undefined ? { config: target.config } : {}),
    });
    // The port promises not to throw; a resolver that does anyway is one
    // app's failure (exit 2 naming it), not a crash of the whole plan.
    let cli: ReturnType<ReactNativeCliResolver['resolve']>;
    try {
      cli = deps.reactNativeCli.resolve(target.root);
    } catch (error) {
      cli = {
        status: 'failed',
        message: `the react-native CLI lookup failed: ${String(error)}`,
      };
    }
    if (cli.status !== 'ok') {
      resolved[key] = { ok: false, reason: cli.message };
      continue;
    }
    let inspected: ReturnType<ReactNativeCliResolver['startOptions']>;
    try {
      inspected = deps.reactNativeCli.startOptions(target.root);
    } catch (error) {
      inspected = { status: 'unknown', message: String(error) };
    }
    resolved[key] = {
      ok: true,
      bundler,
      cli: cli.cli,
      ...(cli.shim !== undefined ? { shim: cli.shim } : {}),
      ...(unreadableRoot && bundlerFromConfigName(target.config) === undefined
        ? {
            bundlerNote:
              "the app root could not be read, so its bundler was not detected; falling back to rspack, Re.Pack's default",
          }
        : {}),
      ...(inspected.status === 'ok'
        ? { startOptions: inspected.options }
        : { startOptionsNote: inspected.message }),
    };
  }
  return resolved;
}
