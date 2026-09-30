// The ONLY import surface for vendored Re.Pack code (docs/PRD.md §6.2,
// .agents/skills/atlas-bridge-vendoring). Everything the rest of Atlas needs
// from Re.Pack-adjacent code is re-exported here; `vendored/**` imports are
// lint-fenced to this directory.
//
// The vendored code is an Atlas-owned fork (Re.Pack will not merge the
// upstream manifest branch; PRD §8.2), so this file is Atlas's own public
// bridge surface, not a request to Re.Pack core. Provenance: VENDORED.md.

import { createRequire } from 'node:module';
import path from 'node:path';
import type { FederationManifestSchema as CoreFederationManifest } from '../core/manifest-types.js';
import type { FederationManifest } from './vendored/federationManifest/index.js';

// --- Vendored manifest plugin (upstream federationManifest/index.ts) --------

export {
  applyFederationManifest,
  type FederationManifestParams,
  normalizeFederationManifestOption,
} from './vendored/federationManifest/index.js';
export { buildFederationManifest } from './vendored/federationManifest/index.js';
export { detectNativeModules } from './vendored/federationManifest/index.js';
export {
  DEFAULT_MANIFEST_FILENAME,
  type FederationManifest,
  type FederationManifestExposeEntry,
  type FederationManifestNativeBlock,
  type FederationManifestObjectOptions,
  type FederationManifestOption,
  type FederationManifestRemoteEntry,
  type FederationManifestSharedEntry,
  type FederationNativeModule,
  type NativeModuleConfidence,
} from './vendored/federationManifest/index.js';

// --- Bridge-owned types ------------------------------------------------------

export type {
  BridgeCompiler,
  BridgeCompilation,
} from './rspack-compiler.js';

// --- Vendored → core type adaptation -----------------------------------------
//
// Core consumes plain structural types it owns (`src/core/manifest-types.ts`);
// the vendored `FederationManifest` is structurally identical for the fields
// core models, so the adaptation is an identity cast. `toCoreManifest` gives
// adapters one named place for the mapping, and the type-level assertion in
// `satisfies` below makes the compiler prove the two copies stay compatible:
// widening or divergence breaks `pnpm typecheck`, not runtime.

export function toCoreManifest(
  manifest: FederationManifest
): CoreFederationManifest {
  return manifest;
}

// Compile-time proof the vendored manifest satisfies the core schema.
// If this ever needs a cast, the types have diverged and T4 consumers break.
const vendoredSatisfiesCore: (m: FederationManifest) => CoreFederationManifest =
  (m) => m;
void vendoredSatisfiesCore;

// --- resolveRepack -----------------------------------------------------------
//
// Re.Pack is a peerDependency resolved from the USER project, Gradle-style —
// never from Atlas's own tree (skill: atlas-bridge-vendoring).

/** Result of locating `@callstack/repack` inside a user project. */
export interface ResolvedRepack {
  /** Absolute path of the `@callstack/repack` package root directory. */
  packageRoot: string;
  /** Parsed contents of its `package.json`. */
  packageJson: { name: string; version: string };
  /**
   * Load a module the way the user project would, e.g.
   * `repack.require('@callstack/repack')` or any subpath its `exports` map
   * allows. CJS `require` semantics — the same resolution used to find the
   * package root.
   */
  require<T = unknown>(specifier: string): T;
}

export class RepackNotResolvedError extends Error {
  constructor(projectRoot: string, cause: unknown) {
    super(
      `Could not resolve '@callstack/repack' from the user project at ` +
        `${projectRoot}. Install it in the app workspace first:\n\n` +
        `  npm install @callstack/repack   # or pnpm/yarn add, in the app that ` +
        `uses Re.Pack\n\n` +
        `Atlas resolves Re.Pack from the project it inspects, never from its ` +
        `own dependencies.\n` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'RepackNotResolvedError';
  }
}

/**
 * Locate `@callstack/repack` as installed in `projectRoot`, resolving through
 * that project's own `node_modules` (createRequire from
 * `<projectRoot>/package.json`). Throws {@link RepackNotResolvedError} when
 * the user project does not have it.
 */
export function resolveRepack(projectRoot: string): ResolvedRepack {
  const requireFromProject = createRequire(
    path.join(projectRoot, 'package.json')
  );
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromProject.resolve('@callstack/repack/package.json');
  } catch (error) {
    throw new RepackNotResolvedError(projectRoot, error);
  }
  // Node's `require` of a .json file returns the parsed object already.
  const packageJson = requireFromProject('@callstack/repack/package.json') as {
    name?: string;
    version?: string;
  };
  return {
    packageRoot: path.dirname(packageJsonPath),
    packageJson: {
      name: packageJson.name ?? '@callstack/repack',
      version: packageJson.version ?? 'unknown',
    },
    require<T = unknown>(specifier: string): T {
      return requireFromProject(specifier) as T;
    },
  };
}
