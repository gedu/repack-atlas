---
name: atlas-bridge-vendoring
description: >-
  Protocol for the Re.Pack bridge: add or change the Atlas-owned forked Re.Pack
  code safely, keep VENDORED.md provenance and MIT headers, respect the lint
  fence, and resolve @callstack/repack from the user project. Trigger: touching
  src/repack-bridge/, src/repack-bridge/vendored/, or VENDORED.md; copying code
  out of Re.Pack; a bridge import fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
metadata:
  auto_invoke:
    - "importing or copying any code from Re.Pack"
    - "modifying src/repack-bridge/**"
---

# Bridge vendoring

Atlas needs Re.Pack internals that are not merged upstream, and Re.Pack ships a
strict `exports` map so deep `dist/...` imports throw
`ERR_PACKAGE_PATH_NOT_EXPORTED`. The manifest plugin was therefore copied from
`feat/federation-manifest` @ `c5df67f0`. That branch (PR #1463) will never be
merged into Re.Pack (owner decision, 2026-09-30), so there is no swap back to a
Re.Pack export: the copy is an Atlas-owned fork and a supported Atlas package.
Atlas may evolve it and validates Re.Pack / Module Federation compatibility
itself. The bridge is the only place that code lives.

## Hard rules

1. `src/repack-bridge/vendored/**` is imported **only** from
   `src/repack-bridge/**`. The `atlas/bridge-fence` ESLint rule enforces it; the
   CI `Vendored provenance check` step (`pnpm check:vendored`) requires every vendored file to appear in
   `VENDORED.md`. Never weaken either to make a build pass.
2. `src/repack-bridge/index.ts` is the **only import surface** the rest of the
   app may use. Everything else goes through it.
3. Keep upstream MIT copyright headers intact in every vendored file. Adding a
   header line to the top of the copy is fine; deleting one is never.
4. Re.Pack is a peerDependency resolved from the **user project**, never from
   Atlas's own `node_modules`.

## Adding a vendored file

1. Copy from the upstream source of record: repo `callstack/repack`, branch
   `feat/federation-manifest`, commit `c5df67f0`.
2. Record it in `VENDORED.md` (repo root) immediately, in the same commit. Entry
   format, one block per file:

   ```markdown
   ## `src/repack-bridge/vendored/plugins/federationManifest/FederationManifestPlugin.ts`

   - **Upstream**: `callstack/repack`
   - **Branch**: `feat/federation-manifest`
   - **Commit**: `c5df67f0`
   - **Upstream path**: `packages/repack/src/plugins/federationManifest/FederationManifestPlugin.ts`
   - **Why vendored**: the manifest plugin is not merged upstream and the
     `exports` map blocks deep imports, so Atlas cannot reach it.
   ```
3. Re-export it from `src/repack-bridge/index.ts`.
4. Run `pnpm lint && pnpm typecheck && pnpm test`.

## Resolving Re.Pack from the user project

Re.Pack must resolve relative to the workspace being inspected, the way Gradle
walks the project tree — not from wherever Atlas was installed:

```ts
import { createRequire } from 'node:module';
import path from 'node:path';

export function resolveRepack(projectRoot: string): typeof import('@callstack/repack') {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  return require('@callstack/repack');
}
```

Never `import '@callstack/repack'` statically outside the bridge, and never
resolve it from `import.meta.url`. Atlas's own tree deliberately does not
contain it.

## Checks

```bash
pnpm lint                 # fence + core boundary
pnpm typecheck
pnpm test
```

Changing the forked code is a normal reviewed diff: keep the MIT header, and add
an adjustment entry to `VENDORED.md` for every change to a vendored file.
`repack-atlas/plugin` and `repack-atlas/introspection` are Atlas public API
(semver applies once published), so treat changes to their options and output as
API changes.
