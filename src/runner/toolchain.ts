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
  | { ok: true; bundler: Bundler; cli: string }
  | { ok: false; reason: string };

/** Absolute app root → its resolved toolchain (or why it has none). */
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
    const files = await listConfigFiles(deps.fs, target.root);
    const bundler = detectBundler({
      files,
      ...(target.config !== undefined ? { config: target.config } : {}),
    });
    const cli = deps.reactNativeCli.resolve(target.root);
    resolved[target.root] =
      cli.status === 'ok'
        ? { ok: true, bundler, cli: cli.cli }
        : { ok: false, reason: cli.message };
  }
  return resolved;
}
