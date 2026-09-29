// Core-owned manifest schema types (docs/PRD.md §6.1: core reads MF2-compatible
// `mf-manifest.json` field shapes and never learns about Re.Pack).
//
// Provenance: these are independent structural transcriptions of the schema in
// `src/repack-bridge/vendored/federationManifest/types.ts` (upstream
// callstack/repack @ c5df67f0). They are deliberately NOT imports: the
// core-boundary lint fence forbids `src/core/**` from importing the bridge or
// anything vendored, so core defines the shapes it consumes and the bridge
// adapts vendored objects to them (see `toCoreManifest` in
// `src/repack-bridge/index.ts` and the conformance test in
// `tests/repack-bridge.test.ts`). The Re.Pack manifest is a superset of the MF2
// shape; core models only the MF2-compatible subset it analyzes. If the two
// copies ever diverge, the type-level conformance test fails at typecheck.

/** One entry in `shared[]` (MF2 shape). */
export interface ManifestSharedEntry {
  name: string;
  version: string;
  singleton: boolean;
  eager: boolean;
  requiredVersion: string;
}

/** One entry in `remotes[]` (MF2 shape). */
export interface ManifestRemoteEntry {
  federationContainerName: string;
  moduleName: string;
  alias: string;
  entry: string;
}

/** One entry in `exposes[]` (MF2 shape). */
export interface ManifestExposeEntry {
  id: string;
  name: string;
  path: string;
}

/** Confidence level of a native module detection (Re.Pack extension). */
export type ManifestNativeModuleConfidence = 'static' | 'heuristic';

/** One entry in `reactNative.nativeModules` (Re.Pack extension). */
export interface ManifestNativeModule {
  package: string;
  version: string;
  modules?: string[];
  turboModule: boolean;
  confidence: ManifestNativeModuleConfidence;
}

/** React Native extension block (Re.Pack superset of MF2). */
export interface ManifestNativeBlock {
  version: string;
  newArch?: boolean;
  platforms: string[];
  nativeModules: ManifestNativeModule[];
  dynamicImportDetected: boolean;
  note?: string;
}

/** Schema v1 of `repack-federation-manifest.json`, MF2-compatible core. */
export interface FederationManifestSchema {
  manifestVersion: 1;
  id: string;
  name: string;
  metaData: {
    name: string;
    globalName: string;
    type: 'host' | 'remote';
    buildInfo: { buildVersion: string; buildName: string };
    remoteEntry?: { name: string; path: string; type: string };
    publicPath: string;
  };
  shared: ManifestSharedEntry[];
  remotes: ManifestRemoteEntry[];
  exposes: ManifestExposeEntry[];
  reactNative: ManifestNativeBlock;
}

/**
 * A manifest document that passed only the minimal shape check (numeric
 * `manifestVersion` plus a `name` or `id`): manifest content is untrusted
 * input, so consumers treat every other field as possibly absent or shaped
 * differently than the v1 schema. Provenance of the minimal check: upstream
 * `commands/federation/loadManifest.ts` @ c5df67f0.
 */
export interface ParsedFederationManifest {
  manifestVersion: number;
  id: string;
  name: string;
  metaData?: FederationManifestSchema['metaData'];
  shared?: ManifestSharedEntry[];
  remotes?: ManifestRemoteEntry[];
  exposes?: ManifestExposeEntry[];
  reactNative?: Partial<ManifestNativeBlock>;
}

/**
 * Minimal runtime check for an unknown JSON document: a numeric
 * `manifestVersion` and a `name` or `id` to identify it by. Ported from the
 * guard in upstream `commands/federation/loadManifest.ts` @ c5df67f0; the
 * loading itself (fs/fetch) is adapter territory behind the `ManifestSource`
 * port. `id`/`name` are normalized to strings for consumers.
 */
export function isParsedFederationManifest(
  value: unknown
): value is ParsedFederationManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.manifestVersion === 'number' &&
    (typeof candidate.name === 'string' || typeof candidate.id === 'string')
  );
}
