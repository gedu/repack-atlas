// `repack-atlas/plugin` subpath — the demo-story surface: the showcase app
// adds the vendored federation-manifest plugin to each app's rspack config
// (docs/PRD.md §8.1 item 1) while the manifest plugin is unmerged upstream.
//
// Atlas code, not vendored. It mirrors how upstream wires the manifest into
// ModuleFederationPluginV1/V2 (fork @ c5df67f0, ModuleFederationPluginV2.ts
// ~line 397): the plugin's `apply` simply forwards the captured federation
// options to the vendored `applyFederationManifest`, which taps the compiler
// hooks and emits `repack-federation-manifest.json`.
//
// Swap condition: when Re.Pack ships a `manifest` option on its own
// ModuleFederation plugins, users delete this plugin from their configs and
// set `manifest: true` there instead (see VENDORED.md).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BridgeCompiler } from './rspack-compiler.js';
import {
  applyFederationManifest,
  normalizeFederationManifestOption,
} from './vendored/federationManifest/index.js';
import type { FederationManifestOption } from './vendored/federationManifest/index.js';

export type { BridgeCompiler, BridgeCompilation } from './rspack-compiler.js';

/** Federation options the manifest needs, mirroring the MF plugin config. */
export interface FederationManifestPluginOptions {
  /** Container name (`name` in the ModuleFederation config). */
  name: string;
  /** `manifest` option: `true` for defaults, an object to customize. */
  manifest?: FederationManifestOption;
  /** Normalized or raw `shared` config, as passed to the MF plugin. */
  shared?: unknown;
  /** Raw `remotes` config. */
  remotes?: unknown;
  /** Raw `exposes` config. */
  exposes?: unknown;
  /** Resolved remote entry filename, if the MF plugin computed one. */
  filename?: string;
  /**
   * Also write the emitted manifest to disk after each compilation.
   *
   * Why: production builds already write compilation assets under
   * `build/generated/<platform>/`, but under the Re.Pack dev server
   * (`@callstack/repack-dev-server`, watch mode) assets live in a memory
   * output FS and the dev server does not serve them — so
   * `repack-federation-manifest.json` is reachable by neither HTTP nor disk,
   * and Atlas's doctor/dev/studio have nothing to read. With this flag the
   * file lands at `<appRoot>/repack-federation-manifest.json` (i.e. relative
   * to `compiler.context`, honoring `manifest.fileName`/`manifest.filePath`).
   *
   * Defaults to `false`: builds keep their current behavior unless opted in.
   * A disk failure never fails the build — it degrades to a compilation
   * warning. Swap condition (VENDORED.md B1): once the dev server serves
   * emitted assets, or upstream ships a manifest option for this, remove it.
   */
  writeToDisk?: boolean;
}

/** Tap name distinct from the vendored `RepackFederationManifestPlugin`. */
const DISK_WRITER_NAME = 'RepackAtlasManifestDiskWriter';

export class FederationManifestPlugin {
  constructor(private readonly options: FederationManifestPluginOptions) {}

  // `unknown` keeps this assignable to the user project's rspack plugin
  // contract (webpack-style `apply(compiler: Compiler)`); the cast is the
  // single bridge point, same as upstream's internal call site.
  apply(compiler: unknown): void {
    const { name, manifest, shared, remotes, exposes, filename, writeToDisk } =
      this.options;
    if (!manifest) {
      // Same gating as upstream: absent/false must not tap any hook.
      return;
    }
    applyFederationManifest(compiler, {
      option: manifest,
      name: name || 'unknown',
      shared,
      remotes,
      exposes,
      ...(filename !== undefined ? { filename } : {}),
    });
    // Taps after the vendored plugin on purpose: same-hook taps run in
    // registration order, so the manifest asset already exists by then.
    if (writeToDisk) {
      this.applyDiskWriter(compiler as BridgeCompiler, manifest);
    }
  }

  /**
   * Bridge-level addition (VENDORED.md B1 — the vendored files stay
   * byte-identical to upstream): after the vendored plugin emits the
   * manifest asset, copy it from the compilation to the app root on disk.
   */
  private applyDiskWriter(
    compiler: BridgeCompiler,
    manifest: NonNullable<FederationManifestOption>
  ): void {
    const options = normalizeFederationManifestOption(manifest);
    // Same asset name the vendored tap emits (posix, inside the compilation).
    const assetName = options.filePath
      ? path.posix.join(options.filePath, options.fileName)
      : options.fileName;

    compiler.hooks.compilation.tap(DISK_WRITER_NAME, (compilation) => {
      compilation.hooks.afterProcessAssets.tap(DISK_WRITER_NAME, () => {
        try {
          // Silent-but-safe: no asset (nativeAnalysis gate, duplicate-asset
          // skip, older config) means nothing to copy.
          if (!compilation.getAsset(assetName)) {
            return;
          }
          const asset = compilation.assets?.[assetName];
          if (!asset) {
            return;
          }
          const target = path.join(
            compiler.context,
            options.filePath ?? '',
            options.fileName
          );
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, asset.source());
        } catch (error) {
          // Writing to disk must never break the user's build: degrade to
          // a warning, same policy as the vendored emit path.
          compilation.warnings.push(
            new Error(
              `[${DISK_WRITER_NAME}] Failed to write the federation manifest ` +
                `to disk: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        }
      });
    });
  }
}
