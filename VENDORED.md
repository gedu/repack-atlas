# VENDORED.md — provenance ledger for `src/repack-bridge/vendored/`

Every file under `src/repack-bridge/vendored/**` is listed here (CI
`vendored-provenance` check). Upstream source of record for all entries:

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`

Common "why vendored": the federation manifest plugin is **not merged
upstream** (open PR #1463) and Re.Pack's strict `exports` map blocks deep
`dist/...` imports (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so Atlas cannot reach it
as a dependency.

Common "swap condition": Re.Pack core merges the manifest plugin and exports
its types/schema (PRD §8.1 item 1, §8.2; PR #1463 lands) — then each block is
deleted and re-exported from `@callstack/repack` in one commit (skill:
`atlas-bridge-vendoring`, "Swap procedure").

**Owner**: Repack Atlas maintainers (swap tracked against PR #1463).

## Vendored Adjustments (all of them)

- **A1 — `applyFederationManifest.ts`, one type-only import**: upstream
  imports `Compiler as RspackCompiler` from `@rspack/core`. rspack is not an
  Atlas dependency (the bundler lives in the user project), so the import is
  redirected to the bridge-owned minimal structural types in
  `src/repack-bridge/rspack-compiler.js`. No logic changed. Dropped with the
  swap.
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

No other edits exist. Verify with:
`diff <upstream file> <vendored file>` — only the header (A2), A1 in
`applyFederationManifest.ts`, and the A3 annotation sites appear.

## `src/repack-bridge/vendored/federationManifest/types.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/types.ts`
- **Why vendored**: manifest schema/option types; not merged upstream and the
  `exports` map blocks deep imports, so Atlas cannot reach them.
- **Swap condition**: core merges the manifest plugin and exports the manifest
  types (PRD §8.1 item 1 / PR #1463); then re-export from `@callstack/repack`
  and delete.
- **Owner**: Repack Atlas maintainers (swap tracked against PR #1463)

## `src/repack-bridge/vendored/federationManifest/index.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/index.ts`
- **Why vendored**: barrel for the manifest module; same blocking reasons.
- **Swap condition**: identical to `types.ts` — replaced by a re-export from
  `@callstack/repack` when PR #1463 lands.
- **Owner**: Repack Atlas maintainers (swap tracked against PR #1463)

## `src/repack-bridge/vendored/federationManifest/applyFederationManifest.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/applyFederationManifest.ts`
- **Why vendored**: the compiler-hook wiring that emits the manifest; it lives
  inside the MF plugin upstream and is unreachable (unmerged + exports map).
- **Swap condition**: PR #1463 lands and the `manifest` option ships on
  Re.Pack's `ModuleFederationPluginV1/V2`; users then drop
  `repack-atlas/plugin` from their configs and Atlas re-exports from
  `@callstack/repack`.
- **Owner**: Repack Atlas maintainers (swap tracked against PR #1463)
- **Local adjustments**: A1 (rspack type-only import → bridge stand-in).

## `src/repack-bridge/vendored/federationManifest/buildFederationManifest.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/buildFederationManifest.ts`
- **Why vendored**: pure manifest-schema builder used by the emit hook; same
  blocking reasons.
- **Swap condition**: exported with the manifest plugin by core (PR #1463);
  re-export and delete.
- **Owner**: Repack Atlas maintainers (swap tracked against PR #1463)

## `src/repack-bridge/vendored/federationManifest/detectNativeModules.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/detectNativeModules.ts`
- **Why vendored**: RN native-module scan feeding the manifest's
  `reactNative.nativeModules` block; same blocking reasons.
- **Swap condition**: exported with the manifest plugin by core (PR #1463);
  re-export and delete.
- **Owner**: Repack Atlas maintainers (swap tracked against PR #1463)

## `src/repack-bridge/vendored/federationManifest/shared.ts`

- **Upstream**: `callstack/repack`
- **Branch**: `feat/federation-manifest`
- **Commit**: `c5df67f0`
- **Upstream path**: `packages/repack/src/plugins/federationManifest/shared.ts`
- **Why vendored**: transitive helper of `buildFederationManifest.ts`
  (`buildSharedEntries` and the shared-config normalizer); vendoring it is the
  only alternative to stubbing logic.
- **Swap condition**: exported with the manifest plugin by core (PR #1463), or
  replaced once the manifest schema is a published spec; re-export and delete.
- **Owner**: Repack Atlas maintainers (swap tracked against PR #1463)
