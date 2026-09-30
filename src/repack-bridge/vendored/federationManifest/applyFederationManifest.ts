/**
 * Copyright (c) Callstack, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Vendored from callstack/repack, branch feat/federation-manifest,
 * commit c5df67f0, path packages/repack/src/plugins/federationManifest/. See VENDORED.md.
 */
import path from 'node:path';
// Atlas vendoring adjustment (Vendored Adjustment A1 — see VENDORED.md):
// upstream imports `Compiler as RspackCompiler` from '@rspack/core'. rspack is
// not an Atlas dependency (it lives in the user project), so this type-only
// import is swapped for the bridge-owned structural stand-in. No logic change.
import type { Compiler as RspackCompiler } from '../../rspack-compiler.js';
import { buildFederationManifest } from './buildFederationManifest.js';
import { detectNativeModules } from './detectNativeModules.js';
import {
  DEFAULT_MANIFEST_FILENAME,
  type FederationManifestObjectOptions,
  type FederationManifestOption,
} from './types.js';

const PLUGIN_NAME = 'RepackFederationManifestPlugin';

/** Everything the manifest needs, captured from the plugin config at apply. */
export interface FederationManifestParams {
  /** The user-provided `manifest` option (truthy; caller gates the call). */
  option: NonNullable<FederationManifestOption>;
  name: string;
  /** Normalized shared config (what the inner MF plugin receives). */
  shared: unknown;
  /** Raw user `remotes` config, before remote loaders are generated. */
  remotes?: unknown;
  /** Raw user `exposes` config. */
  exposes?: unknown;
  filename?: string;
}

export function normalizeFederationManifestOption(
  option: NonNullable<FederationManifestOption>
  // Atlas vendoring adjustment (A3, type-only): `| undefined` on the optional
  // `filePath` so the explicit-undefined return below is legal under Atlas's
  // `exactOptionalPropertyTypes`. Behavior-identical.
): Required<Omit<FederationManifestObjectOptions, 'filePath'>> & {
  filePath?: string | undefined;
} {
  const objectOptions =
    typeof option === 'object' && option !== null ? option : {};
  return {
    fileName: objectOptions.fileName || DEFAULT_MANIFEST_FILENAME,
    filePath: objectOptions.filePath,
    nativeAnalysis: objectOptions.nativeAnalysis ?? true,
  };
}

/**
 * Register the compiler hooks that emit the Repack federation manifest.
 *
 * Must only be called when the `manifest` option is enabled: this is the
 * only place the plugin taps compiler hooks, keeping the default path
 * byte-identical to the pre-manifest behavior.
 */
export function applyFederationManifest(
  __compiler: unknown,
  params: FederationManifestParams
): void {
  const compiler = __compiler as RspackCompiler;
  const options = normalizeFederationManifestOption(params.option);

  compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
    compilation.hooks.afterProcessAssets.tap(PLUGIN_NAME, () => {
      try {
        const { nativeModules, dynamicImportDetected, degraded } =
          options.nativeAnalysis
            ? detectNativeModules(compilation)
            : {
                nativeModules: [],
                dynamicImportDetected: false,
                degraded: false,
              };

        const rawPublicPath = compiler.options.output.publicPath;
        const manifest = buildFederationManifest({
          context: compiler.context,
          name: params.name,
          shared: params.shared,
          remotes: params.remotes,
          exposes: params.exposes,
          filename: params.filename,
          publicPath:
            typeof rawPublicPath === 'string' ? rawPublicPath : 'auto',
          platform:
            typeof compiler.options.name === 'string'
              ? compiler.options.name
              : undefined,
          nativeModules,
          dynamicImportDetected,
          nativeAnalysis: options.nativeAnalysis,
          nativeAnalysisDegraded: degraded,
        });

        const assetName = options.filePath
          ? path.posix.join(options.filePath, options.fileName)
          : options.fileName;

        if (compilation.getAsset(assetName)) {
          compilation.warnings.push(
            new Error(
              `[${PLUGIN_NAME}] Asset '${assetName}' already exists, ` +
                'skipping manifest emission. Rename it with the manifest.fileName option.'
            )
          );
          return;
        }

        compilation.emitAsset(
          assetName,
          new compiler.webpack.sources.RawSource(
            JSON.stringify(manifest, null, 2)
          )
        );
      } catch (error) {
        // The manifest is observational: a failure here must never fail the
        // build, so degrade to a warning.
        compilation.warnings.push(
          new Error(
            `[${PLUGIN_NAME}] Failed to emit the federation manifest: ` +
              `${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  });
}
