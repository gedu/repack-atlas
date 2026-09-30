// `WorkspaceConfigReader` adapter: discovers and loads
// `repack-federation.json` (docs/PRD.md §6.1). The schema and the
// validation reasons are pure core (`src/core/federation-config.ts`); this
// file adds only what the core cannot own: the filesystem walk and the
// parse orchestration.
//
// Provenance: discovery semantics ported from `findConfigPath` /
// `loadFederationConfig` of `commands/federation/configFile.ts`
// (callstack/repack branch `feat/federation-shared-config` @ c5df67f0):
// walk up from the start directory, the first hit wins, no file → `null`
// (never an error). Adaptation: upstream threw `ConfigFileInvalidError`;
// the port returns typed results so callers keep the invalid-vs-missing
// asymmetry without exception plumbing. `resolveFederationWorkspace` and
// `assertStandaloneSupported` are deferred to T7 (CLI flags / init surface).

import path from 'node:path';
import {
  describeJsonParseFailure,
  FEDERATION_CONFIG_FILENAME,
  validateFederationConfig,
  type FederationConfig,
  type WorkspaceConfigReader,
  type ProjectFs,
} from '../core/index.js';

export type WorkspaceConfigLoadResult =
  | {
      status: 'ok';
      /** Absolute path of the file that was read. */
      filePath: string;
      config: FederationConfig;
    }
  /** No `repack-federation.json` exists anywhere up the tree. */
  | { status: 'missing' }
  /** A file exists but is not valid JSON or violates the schema. */
  | { status: 'invalid'; filePath: string; reasons: string[] };

/** The reader port plus the typed API core/CLI consumers actually need. */
export interface AtlasWorkspaceConfigReader extends WorkspaceConfigReader {
  /** Walk up from `startDir`, first hit wins; typed never-throws result. */
  load(startDir: string): Promise<WorkspaceConfigLoadResult>;
  /** Path of the file a walk-up from `startDir` would read, or `null`. */
  findConfigPath(startDir: string): Promise<string | null>;
}

/**
 * @param fs Filesystem behind the `ProjectFs` port (fixtures in tests).
 */
export function createWorkspaceConfigReader(
  fs: ProjectFs
): AtlasWorkspaceConfigReader {
  async function findConfigPath(
    startDir: string
  ): Promise<string | null> {
    let currentDir = path.resolve(startDir);
    for (;;) {
      const candidate = path.join(currentDir, FEDERATION_CONFIG_FILENAME);
      if (await fs.exists(candidate)) return candidate;
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) return null;
      currentDir = parentDir;
    }
  }

  async function load(
    startDir: string
  ): Promise<WorkspaceConfigLoadResult> {
    const filePath = await findConfigPath(startDir);
    if (filePath === null) return { status: 'missing' };

    const rawText = await fs.readFile(filePath);
    if (rawText === null) {
      // The file vanished or is unreadable between discovery and read:
      // an answer exists but cannot be read — same class as invalid.
      return {
        status: 'invalid',
        filePath,
        reasons: ['could not be read'],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch (error) {
      return {
        status: 'invalid',
        filePath,
        reasons: [describeJsonParseFailure(rawText, error)],
      };
    }

    const reasons = validateFederationConfig(parsed);
    if (reasons.length > 0) return { status: 'invalid', filePath, reasons };
    return { status: 'ok', filePath, config: parsed as FederationConfig };
  }

  return {
    findConfigPath,
    load,
    // Port surface: the parsed document, or null when nothing was found.
    // Callers that must distinguish invalid from missing use `load`.
    async read(workspaceRoot: string): Promise<unknown> {
      const result = await load(workspaceRoot);
      return result.status === 'ok' ? result.config : null;
    },
  };
}
