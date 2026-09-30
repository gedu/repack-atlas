// Workspace → doctor input resolution for `repack-atlas doctor` (T7).
//
// Lives between the command handler and the ports on purpose: the resolution
// rules below are what makes the exit-code contract honest — a *host* that
// cannot be read means "no answer" (report `unableToAnswer`, exit 2), while a
// missing *remote* manifest is an answer ("that remote was never checked",
// `MISSING_REMOTE_MANIFEST`, exit 1) and a corrupt remote manifest is "an
// answer exists but we cannot read it" (exit 2). Encoding that in the CLI
// handler itself would spread the asymmetry across commands.

import path from 'node:path';
import type { AtlasWorkspaceConfigReader } from '../adapters/workspace-config.js';
import {
  isUrlSource,
  runDoctor,
  unableToAnswerReport,
  type DoctorRemoteInput,
  type DoctorReport,
  type FederationConfig,
  type ManifestSource,
} from '../core/index.js';

/** One endpoint collected from explicit flags or from the workspace config. */
export interface EndpointPlan {
  name: string;
  /** Manifest reference: .json path, directory, or URL. */
  manifest: string;
  /** Root used to resolve relative manifest paths (config dir / cwd). */
  root?: string;
}

export type DoctorSourcePlan =
  | { ok: true; host: EndpointPlan; remotes: EndpointPlan[] }
  | { ok: false; reasons: string[] };

/**
 * Collect the host/remote references from the two mutually exclusive input
 * modes: explicit `--host`/`--remote` flags (repeatable remotes) or workspace
 * mode, which discovers `repack-federation.json` by walking up and reads the
 * per-app `manifest` refs from it. Never throws; failures come back as
 * human-readable reasons the caller prints with exit code 2.
 */
export async function buildDoctorPlan(options: {
  hostRef?: string;
  remoteRefs: string[];
  workspaceDir?: string;
  configReader: AtlasWorkspaceConfigReader;
}): Promise<DoctorSourcePlan> {
  const explicit =
    options.hostRef !== undefined || options.remoteRefs.length > 0;

  if (explicit) {
    if (options.workspaceDir !== undefined) {
      return {
        ok: false,
        reasons: [
          '--workspace cannot be combined with --host/--remote; choose one input mode',
        ],
      };
    }
    if (options.hostRef === undefined) {
      return { ok: false, reasons: ['--host is required with explicit mode'] };
    }
    if (options.remoteRefs.length === 0) {
      return { ok: false, reasons: ['at least one --remote is required'] };
    }
    const remotes = options.remoteRefs.map((ref, index) => ({
      name: remoteNameFromRef(ref) ?? `remote-${index + 1}`,
      manifest: ref,
    }));
    return {
      ok: true,
      host: { name: remoteNameFromRef(options.hostRef) ?? 'host', manifest: options.hostRef },
      remotes,
    };
  }

  const startDir = path.resolve(options.workspaceDir ?? process.cwd());
  const result = await options.configReader.load(startDir);
  if (result.status === 'missing') {
    return {
      ok: false,
      reasons: [
        `no repack-federation.json found walking up from ${startDir}`,
      ],
    };
  }
  if (result.status === 'invalid') {
    return {
      ok: false,
      reasons: [`${result.filePath} ${result.reasons.join('; ')}`],
    };
  }
  return planFromConfig(result.config, path.dirname(result.filePath));
}

/** Turn a validated config + its directory into endpoint plans. */
export function planFromConfig(
  config: FederationConfig,
  configDir: string
): DoctorSourcePlan {
  return {
    ok: true,
    host: { name: 'host', manifest: config.host.manifest, root: configDir },
    remotes: Object.entries(config.remotes).map(([name, entry]) => ({
      name,
      manifest: entry.manifest,
      root: configDir,
    })),
  };
}

/**
 * Derive a display name from a manifest reference: the JSON basename for
 * files, the hostname for URLs. Purely cosmetic — user-facing names in
 * findings — so a weird ref simply falls back to `undefined`.
 */
export function remoteNameFromRef(ref: string): string | undefined {
  if (isUrlSource(ref)) {
    try {
      return new URL(ref).hostname;
    } catch {
      return undefined;
    }
  }
  const parsed = path.parse(path.resolve(ref));
  const base = parsed.ext.toLowerCase() === '.json' ? parsed.name : parsed.name || parsed.dir;
  return base.length > 0 ? base : undefined;
}

/** Resolve a manifest reference against the plan root (URLs stay verbatim). */
export function resolveEndpointRef(endpoint: EndpointPlan): string {
  if (isUrlSource(endpoint.manifest)) return endpoint.manifest;
  return endpoint.root
    ? path.resolve(endpoint.root, endpoint.manifest)
    : path.resolve(endpoint.manifest);
}

export interface ResolvedDoctorRun {
  report: DoctorReport;
  /** Where each endpoint's manifest actually came from, for output headers. */
  sources: {
    host: { name: string; resolvedFrom?: string; failure?: string };
    remotes: { name: string; resolvedFrom?: string }[];
  };
}

/**
 * Load every endpoint through the `ManifestSource` port and run the pure
 * doctor over the results, applying the missing/corrupt asymmetry described
 * at the top of this file. Never throws.
 */
export async function runDoctorFromPlan(
  plan: Extract<DoctorSourcePlan, { ok: true }>,
  manifestSource: ManifestSource,
  options: { allowMissingManifests?: boolean } = {}
): Promise<ResolvedDoctorRun> {
  const hostResult = await manifestSource.load(resolveEndpointRef(plan.host));
  if (hostResult.status === 'failed') {
    // Host problems are always "no answer": without the host there is
    // nothing to compare against, whatever the failure kind.
    return {
      report: unableToAnswerReport(
        `Host manifest could not be used: ${hostResult.message}`
      ),
      sources: {
        host: { name: plan.host.name, failure: hostResult.message },
        remotes: [],
      },
    };
  }

  const remotes: DoctorRemoteInput[] = [];
  const remoteSources: { name: string; resolvedFrom?: string }[] = [];
  for (const remote of plan.remotes) {
    const result = await manifestSource.load(resolveEndpointRef(remote));
    if (result.status === 'ok') {
      remotes.push({ name: remote.name, manifest: result.manifest });
      remoteSources.push({ name: remote.name, resolvedFrom: result.resolvedFrom });
    } else if (result.failure === 'corrupt') {
      remotes.push({ name: remote.name, corrupt: true });
      remoteSources.push({ name: remote.name });
    } else {
      remotes.push({ name: remote.name, missing: true });
      remoteSources.push({ name: remote.name });
    }
  }

  const report = runDoctor({
    host: hostResult.manifest,
    remotes,
    ...(options.allowMissingManifests ? { allowMissingManifests: true } : {}),
  });
  return {
    report,
    sources: {
      host: { name: plan.host.name, resolvedFrom: hostResult.resolvedFrom },
      remotes: remoteSources,
    },
  };
}
