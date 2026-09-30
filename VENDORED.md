# VENDORED.md — provenance ledger for `src/repack-bridge/vendored/`

Every file under `src/repack-bridge/vendored/**` is listed here (CI
`Vendored provenance check` step, `pnpm check:vendored`). Upstream source of record for all entries:

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`

Why this code lives here: the federation manifest plugin was copied from an
unmerged Re.Pack branch (PR #1463) because Re.Pack's strict `exports` map
blocks deep `dist/...` imports (`ERR_PACKAGE_PATH_NOT_EXPORTED`). That PR will
never be merged into Re.Pack (owner decision, 2026-09-30), so there is no swap
back to a Re.Pack export. The code is an **Atlas-owned fork** and a supported
Atlas package: Atlas may evolve it, and Re.Pack / Module Federation
compatibility is validated by Atlas, not upstream. This ledger stays for
provenance and the MIT license obligation: each entry records where the file
came from and the MIT header it carries.

**Owner**: Repack Atlas maintainers.

## Vendored Adjustments (all of them)

- **A1 — `applyFederationManifest.ts`, one type-only import**: upstream
  imports `Compiler as RspackCompiler` from `@rspack/core`. rspack is not an
  Atlas dependency (the bundler lives in the user project), so the import is
  redirected to the bridge-owned minimal structural types in
  `src/repack-bridge/rspack-compiler.js`. No logic changed.
- **A2 — MIT headers added**: upstream ships **no per-file license headers**
  in `plugins/federationManifest/*` (MIT lives only in the repo-root
  `LICENSE`, "Copyright (c) 2025 Callstack"). Each vendored copy carries an
  added MIT © Callstack header per the bridge skill ("Adding a header line to
  the top of the copy is fine"). Nothing was removed.
- **A3 — strict-TS type annotations only** (no runtime-behavior change; Atlas
  compiles with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`,
  stricter than the upstream tsconfig):
  - `applyFederationManifest.ts`: `filePath?: string | undefined` in
    `normalizeFederationManifestOption`'s return type (it returns an explicit
    `filePath: undefined`).
  - `buildFederationManifest.ts`: `filename?: string | undefined` and
    `platform?: string | undefined` in `BuildFederationManifestParams` (the
    call site passes explicit `undefined`).
  - `shared.ts`: `fromObject` extracts `keys[0]` into a local `firstKey` with
    an `!== undefined` guard (redundant at runtime — `keys.length === 1`
    already proves definedness — required by `noUncheckedIndexedAccess`).

These are the edits made at copy time; future Atlas changes to the fork are
recorded here as further adjustments. To see how a file differs from its
source, run `diff <upstream file at c5df67f0> <vendored file>`; at the time of
the copy only the header (A2), A1 in `applyFederationManifest.ts`, and the A3
annotation sites appear.

## Bridge additions (non-vendored)

These live in Atlas-owned files (`src/repack-bridge/plugin.ts`,
`src/repack-bridge/rspack-compiler.ts`), **not** under `vendored/`. So far the
vendored files above match upstream commit `c5df67f0` modulo A1–A3.

- **B1 — `writeToDisk` option on the `repack-atlas/plugin` wrapper**:
  under the Re.Pack dev server (`@callstack/repack-dev-server` 5.3.0, watch
  mode) compilation assets live in a memory output FS and the dev server
  serves neither them nor the manifest — verified with real 404s on every
  path variant for `repack-federation-manifest.json` in a live workspace
  while the production build writes the file under
  `build/generated/<platform>/`. The wrapper therefore taps
  `compilation.hooks.afterProcessAssets` as `RepackAtlasManifestDiskWriter`
  (registered after the vendored tap, so the asset exists) and, when
  `writeToDisk: true`, copies the emitted asset to
  `<compiler.context>/<filePath>/<fileName>`. Missing assets are skipped
  silently; disk failures degrade to a compilation warning and never fail
  the build.
  Atlas keeps this option as part of its supported plugin API; if the Re.Pack
  dev server later serves emitted assets, revisit it and record the decision
  here.

## `src/repack-bridge/vendored/federationManifest/types.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/types.ts`
- **Why vendored**: manifest schema/option types; copied from the unmerged
  upstream branch because the `exports` map blocks deep imports.

## `src/repack-bridge/vendored/federationManifest/index.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/index.ts`
- **Why vendored**: barrel for the manifest module; same reasons.

## `src/repack-bridge/vendored/federationManifest/applyFederationManifest.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/applyFederationManifest.ts`
- **Why vendored**: the compiler-hook wiring that emits the manifest; it lives
  inside the MF plugin upstream and was unreachable (unmerged + exports map).

- **Local adjustments**: A1 (rspack type-only import → bridge stand-in).

## `src/repack-bridge/vendored/federationManifest/buildFederationManifest.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/buildFederationManifest.ts`
- **Why vendored**: pure manifest-schema builder used by the emit hook; same
  reasons.

## `src/repack-bridge/vendored/federationManifest/detectNativeModules.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/detectNativeModules.ts`
- **Why vendored**: RN native-module scan feeding the manifest's
  `reactNative.nativeModules` block; same reasons.

## `src/repack-bridge/vendored/federationManifest/shared.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/shared.ts`
- **Why vendored**: transitive helper of `buildFederationManifest.ts`
  (`buildSharedEntries` and the shared-config normalizer); copying it is the
  only alternative to stubbing logic.

