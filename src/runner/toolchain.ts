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
      /** Set when the bundler is a guess: the app root could not be listed,
       * so rspack (Re.Pack's default) was assumed. */
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

/** Whether the `config` field's file name alone decides the bundler. */
const configNamesBundler = (config: string | undefined): boolean =>
  config !== undefined && /^(rspack|webpack)/.test(path.basename(config));

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
    let files: string[] = [];
    let listingFailure: string | undefined;
    try {
      files = await listConfigFiles(deps.fs, target.root);
    } catch (error) {
      // An unreadable root lists nothing: detection falls back to rspack, and
      // says so (unless the `config` field already decides the bundler).
      listingFailure = String(error);
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
      ...(listingFailure !== undefined && !configNamesBundler(target.config)
        ? {
            bundlerNote: `could not list the app root to detect its bundler (${listingFailure}); assuming rspack, Re.Pack's default`,
          }
        : {}),
      ...(inspected.status === 'ok'
        ? { startOptions: inspected.options }
        : { startOptionsNote: inspected.message }),
    };
  }
  return resolved;
}
