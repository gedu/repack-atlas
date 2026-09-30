// Workspace → graph composition for the Studio (T8).
//
// The server owns transport only; something has to read `repack-federation.json`,
// load every app's manifest through the `ManifestSource` port, run the doctor
// and hand the result to `buildFederationGraph`. That something lives here
// rather than in the preview tool or the runner so both (and the tests) share
// one loader — the same composition `src/cli/plan.ts` performs for `doctor`,
// reused instead of re-derived.
//
// Statuses are injected by the caller (`statuses()`), because the loader is
// stateless about dev servers: the T9 runner knows whether an app is bundling,
// the Studio does not.

import path from 'node:path';
import {
  buildFederationGraph,
  runDoctor,
  unableToAnswerReport,
  type AppStatusMap,
  type DoctorReport,
  type FederationConfig,
  type FederationGraph,
  type FederationGraphInput,
  type ManifestSource,
} from '../core/index.js';
import type { AtlasWorkspaceConfigReader } from '../adapters/workspace-config.js';
import type { StudioGraphSource } from './server.js';

export interface WorkspaceGraphSourceOptions {
  /** Directory to walk up from when discovering `repack-federation.json`. */
  workspaceDir: string;
  configReader: AtlasWorkspaceConfigReader;
  manifestSource: ManifestSource;
  /** Live statuses; defaults to "everything idle". */
  statuses?: () => AppStatusMap;
  /** Called when the workspace itself cannot be read (config missing/invalid). */
  onWorkspaceError?: (reason: string) => void;
}

/** Resolve a manifest reference the way the doctor does (URLs stay verbatim). */
function resolveRef(configDir: string, ref: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(ref) ? ref : path.resolve(configDir, ref);
}

/**
 * Build a `StudioGraphSource` for a workspace on disk. Never throws: an
 * unreadable workspace yields an `unableToAnswer` finding list and an empty
 * graph, which the page renders honestly instead of a 500.
 */
export function createWorkspaceGraphSource(
  options: WorkspaceGraphSourceOptions
): StudioGraphSource {
  async function load(): Promise<{
    config: FederationConfig | null;
    configDir: string;
    /** Graph node name of the host (manifest name, else `host`). */
    hostName: string;
    report: DoctorReport;
    inputs: FederationGraphInput[];
  }> {
    const loaded = await options.configReader.load(options.workspaceDir);
    if (loaded.status !== 'ok') {
      const reason =
        loaded.status === 'missing'
          ? `no repack-federation.json found walking up from ${options.workspaceDir}`
          : `${loaded.filePath} ${loaded.reasons.join('; ')}`;
      options.onWorkspaceError?.(reason);
      return {
        config: null,
        configDir: options.workspaceDir,
        hostName: 'host',
        report: unableToAnswerReport(`Studio: ${reason}`),
        inputs: [],
      };
    }

    const { config, filePath } = loaded;
    const configDir = path.dirname(filePath);

    const hostResult = await options.manifestSource.load(
      resolveRef(configDir, config.host.manifest)
    );
    if (hostResult.status === 'failed') {
      // Same asymmetry the CLI applies: without a host there is no answer.
      return {
        config,
        configDir,
        hostName: 'host',
        report: unableToAnswerReport(
          `Studio: host manifest could not be used: ${hostResult.message}`
        ),
        inputs: [],
      };
    }

    const inputs: FederationGraphInput[] = [
      {
        name: hostResult.manifest.name || 'host',
        role: 'host',
        manifest: hostResult.manifest,
      },
    ];
    const remotes = [];
    for (const [name, remote] of Object.entries(config.remotes)) {
      const result = await options.manifestSource.load(
        resolveRef(configDir, remote.manifest)
      );
      if (result.status === 'ok') {
        inputs.push({ name, role: 'remote', manifest: result.manifest });
        remotes.push({ name, manifest: result.manifest });
      } else if (result.failure === 'corrupt') {
        remotes.push({ name, corrupt: true });
      } else {
        remotes.push({ name, missing: true });
      }
    }

    return {
      config,
      configDir,
      hostName: inputs[0]!.name,
      report: runDoctor({ host: hostResult.manifest, remotes }),
      inputs,
    };
  }

  return {
    statuses: options.statuses ?? (() => ({})),
    async build(statuses: AppStatusMap): Promise<FederationGraph> {
      const { config, hostName, report, inputs } = await load();
      if (!config) {
        return { apps: [], edges: [], findings: report.findings };
      }
      // The runner keys statuses by the config key `host` (the only name a
      // user types); the graph node is named from the host manifest. Alias
      // so live statuses land on the right node even when the two differ —
      // including when the manifest is missing or corrupt (the graph names
      // the node `host` then, and an unreadable app is exactly when a live
      // `error` status matters most).
      const keyed: AppStatusMap = { ...statuses };
      if (statuses.host !== undefined && keyed[hostName] === undefined) {
        keyed[hostName] = statuses.host;
      }
      return buildFederationGraph(config, inputs, report.findings, {
        statuses: keyed,
      });
    },
  };
}
