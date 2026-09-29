// Ports owned by the core (docs/PRD.md §6.1): interfaces only, no
// implementations. Adapters (T5, `src/adapters/**`) provide file/URL/
// dev-server manifest sources and the workspace config reader; the core
// consumes them through these contracts and never imports them.

import type { ParsedFederationManifest } from './manifest-types.js';

/**
 * Why a manifest could not be turned into a usable document. The
 * corrupt-vs-missing asymmetry is load-bearing: `missing` means "nothing is
 * served there" (the remote may simply not have the plugin enabled →
 * `MISSING_REMOTE_MANIFEST` finding), while `corrupt` means "an answer
 * exists but we cannot read it" → the caller marks the report
 * `unableToAnswer` (exit code 2).
 */
export type ManifestLoadFailure = 'missing' | 'corrupt';

/** Outcome of loading one manifest: a parsed document or a typed failure. */
export type ManifestLoadResult =
  | {
      status: 'ok';
      manifest: ParsedFederationManifest;
      /** Where the document was actually read from (path or URL). */
      resolvedFrom: string;
    }
  | {
      status: 'failed';
      failure: ManifestLoadFailure;
      /** Human-readable cause for report messages. */
      message: string;
    };

/**
 * Loads federation manifests by reference (file path, directory, URL, or
 * dev-server address — the reference grammar is the adapter's business).
 * Implementations must never throw: failures come back typed so the rule
 * engine can distinguish "no manifest" from "unreadable manifest".
 */
export interface ManifestSource {
  load(ref: string): Promise<ManifestLoadResult>;
}

/**
 * Reads the Atlas workspace config (`repack-federation.json`). Owned by core
 * so doctor/CLI code can depend on it; shape finalized with the T5 adapter.
 */
export interface WorkspaceConfigReader {
  read(workspaceRoot: string): Promise<unknown>;
}
