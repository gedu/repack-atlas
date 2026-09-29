// Atlas-owned (NOT vendored) minimal structural stand-in for the rspack
// `Compiler`/`Compilation` types that the vendored manifest plugin touches.
//
// Why this exists: upstream `applyFederationManifest.ts` gets its compiler
// typing from `@rspack/core`, which is not a dependency of Atlas (the bundler
// lives in the user project). Importing it would either pull rspack into our
// tree or break `pnpm typecheck`. The only touched line in the vendored copy
// swaps that one type-only import for this file; no logic changes.
//
// These types describe exactly the surface `applyFederationManifest` uses,
// nothing more. They are intentionally loose (`unknown` returns) so the
// vendored code keeps compiling against whatever rspack version the user
// project ships. Swap condition: once Re.Pack exports a typed manifest
// application entry point (VENDORED.md), this file goes away with it.

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
