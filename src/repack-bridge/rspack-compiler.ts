// Atlas-owned (NOT vendored) minimal structural stand-in for the rspack
// `Compiler`/`Compilation` types that the vendored manifest plugin touches.
//
// Why this exists: upstream `applyFederationManifest.ts` gets its compiler
// typing from `@rspack/core`, which is not a dependency of Atlas (the bundler
// lives in the user project). Importing it would either pull rspack into our
// tree or break `pnpm typecheck`. The only touched line in the vendored copy
// redirects that one type-only import to this file; no logic changes.
//
// These types describe exactly the surface `applyFederationManifest` uses,
// nothing more. They are intentionally loose (`unknown` returns) so the
// vendored code keeps compiling against whatever rspack version the user
// project ships. Atlas owns this file along with the forked manifest plugin
// (VENDORED.md).

/** The compilation hooks the manifest plugin taps. */
export interface BridgeCompilation {
  hooks: {
    afterProcessAssets: { tap(name: string, fn: () => void): void };
  };
  /** Iterated by the native-module scan. */
  modules?: Iterable<unknown>;
  /** Read for the dynamic-require heuristic, written on manifest failures. */
  warnings: { message?: string }[];
  getAsset(name: string): unknown;
  emitAsset(name: string, source: unknown): void;
  /**
   * Emitted asset sources, keyed by asset name. Read by the bridge's
   * `writeToDisk` disk writer (`src/repack-bridge/plugin.ts`); optional
   * because the vendored code never touches it and older doubles may not
   * provide it. `source()` mirrors webpack/rspack `Source#source()`
   * (string or Buffer; Buffer is a Uint8Array).
   */
  assets?: Record<string, { source(): string | Uint8Array }>;
}

/** The compiler surface the manifest plugin taps. */
export interface BridgeCompiler {
  context: string;
  options: {
    name?: string;
    output: { publicPath?: string };
  };
  hooks: {
    compilation: {
      tap(name: string, fn: (compilation: BridgeCompilation) => void): void;
    };
  };
  webpack: {
    sources: {
      RawSource: new (value: string) => unknown;
    };
  };
}

/** Alias so the vendored `Compiler as RspackCompiler` import reads as upstream. */
export type Compiler = BridgeCompiler;
