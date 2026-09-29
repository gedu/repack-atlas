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

import { applyFederationManifest } from './vendored/federationManifest/index.js';
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
}

export class FederationManifestPlugin {
  constructor(private readonly options: FederationManifestPluginOptions) {}

  // `unknown` keeps this assignable to the user project's rspack plugin
  // contract (webpack-style `apply(compiler: Compiler)`); the cast is the
  // single bridge point, same as upstream's internal call site.
  apply(compiler: unknown): void {
    const { name, manifest, shared, remotes, exposes, filename } =
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
  }
}
