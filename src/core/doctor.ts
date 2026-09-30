// Pure doctor rule engine: compares a host manifest against remote manifests
// and reports every shared-dependency / native-module inconsistency, plus
// Atlas's REMOTE_CYCLE rule. No IO — manifests arrive as parsed documents;
// loading happens behind the `ManifestSource` port (src/core/ports.ts).
//
// Provenance: rules, severities, finding codes and message wording are ported
// from `packages/repack/src/commands/federation/doctor.ts` of
// callstack/repack @ c5df67f0 (branch `feat/federation-manifest`). Deviations:
//   - Input types are core-owned (`ParsedFederationManifest`), not bridge types.
//   - `REMOTE_CYCLE` is an Atlas addition (Studio plan Phase 1, see cycle.ts).
//   - `confidence` is declared on every finding (AGENTS.md rule 7).
//   - `doctorReportToJson` emits the Atlas `--json` contract from
//     .agents/skills/atlas-doctor-finding instead of upstream's bare
//     `{findings}` payload; the stable key order is preserved.

import { detectRemoteCycles } from './cycle.js';
import {
  doctorExitCode,
  type DoctorExitCodeOptions,
} from './exit-codes.js';
import type {
  DoctorFinding,
  DoctorReport,
  FindingConfidence,
} from './findings.js';
import type {
  ManifestNativeModule,
  ManifestSharedEntry,
  ParsedFederationManifest,
} from './manifest-types.js';
import { rangesIntersect } from './semverRange.js';

/** The highest manifest schema version this doctor understands. */
const SUPPORTED_MANIFEST_VERSION = 1;

/** A remote to compare against the host. */
export interface DoctorRemoteInput {
  /** Name used to refer to the remote in findings. */
  name: string;
  /** Its manifest, when available. */
  manifest?: ParsedFederationManifest;
  /** True when no manifest exists at this remote's source. */
  missing?: boolean;
  /**
   * True when a manifest exists but could not be read or parsed. Honest
   * asymmetry (AGENTS.md rule 6): this is not `missing`. It becomes a named
   * `MANIFEST_UNREADABLE` error finding (exit 1) while another remote can
   * still be checked; when no remote is comparable the report is "unable to
   * answer" (exit 2).
   */
  corrupt?: boolean;
  /** Manifest reference (path, directory or URL) named in the finding. */
  ref?: string;
  /** Why the manifest could not be used (parse/read reason). */
  reason?: string;
}

export interface DoctorInput {
  host: ParsedFederationManifest;
  remotes: DoctorRemoteInput[];
  /** Downgrade missing-remote findings from error to warning. */
  allowMissingManifests?: boolean;
}

function sharedOf(manifest: ParsedFederationManifest): ManifestSharedEntry[] {
  return Array.isArray(manifest.shared) ? manifest.shared : [];
}

function nativeModulesOf(
  manifest: ParsedFederationManifest
): ManifestNativeModule[] {
  const modules = manifest.reactNative?.nativeModules;
  return Array.isArray(modules) ? modules : [];
}

/**
 * A host native-module list is only authoritative when nothing was detected
 * heuristically and no dynamic require was seen in the module graph.
 */
function hostNativeListIsTrusted(host: ParsedFederationManifest): boolean {
  const native = host.reactNative;
  if (!native || native.dynamicImportDetected) return false;
  return !nativeModulesOf(host).some(
    (entry) => entry.confidence === 'heuristic'
  );
}

function checkManifestVersion(
  manifest: ParsedFederationManifest,
  label: string,
  findings: DoctorFinding[]
): void {
  const version = manifest.manifestVersion;
  if (typeof version === 'number' && version > SUPPORTED_MANIFEST_VERSION) {
    findings.push({
      severity: 'warning',
      code: 'MANIFEST_VERSION_AHEAD',
      message: `${label} declares manifestVersion ${version}, newer than the v1 schema this doctor understands; comparing best effort.`,
      confidence: 'static',
    });
  }
}

function checkSharedDeps(
  host: ParsedFederationManifest,
  remoteName: string,
  remote: ParsedFederationManifest,
  findings: DoctorFinding[]
): void {
  const remoteShared = new Map(
    sharedOf(remote).map((entry) => [entry.name, entry])
  );

  for (const hostEntry of sharedOf(host)) {
    const remoteEntry = remoteShared.get(hostEntry.name);
    if (!remoteEntry) continue;
    const name = hostEntry.name;

    if (hostEntry.singleton !== remoteEntry.singleton) {
      findings.push({
        severity: 'error',
        code: 'SINGLETON_MISMATCH',
        message: `Shared dependency "${name}" is singleton: ${hostEntry.singleton} on host "${host.name}" but ${remoteEntry.singleton} on remote "${remoteName}".`,
        confidence: 'static',
      });
    }
    if (hostEntry.eager !== remoteEntry.eager) {
      const conventional = hostEntry.eager && !remoteEntry.eager; // host-eager / remote-lazy = MF convention
      findings.push({
        severity: conventional ? 'warning' : 'error',
        code: conventional ? 'EAGER_ADVISORY' : 'EAGER_MISMATCH',
        message: conventional
          ? `Shared dependency "${name}" is eager: true on host "${host.name}" but eager: false on remote "${remoteName}" — expected host-eager/remote-lazy convention; reported as advisory.`
          : `Shared dependency "${name}" is eager: ${hostEntry.eager} on host "${host.name}" but ${remoteEntry.eager} on remote "${remoteName}".`,
        confidence: 'static',
      });
    }

    const bothSingleton = hostEntry.singleton && remoteEntry.singleton;
    if (bothSingleton && hostEntry.version !== remoteEntry.version) {
      if (
        hostEntry.version === 'unknown' ||
        remoteEntry.version === 'unknown'
      ) {
        findings.push({
          severity: 'info',
          code: 'VERSION_UNKNOWN',
          message: `Shared dependency "${name}" is a singleton but its resolved version could not be determined on at least one side (host: ${hostEntry.version}, remote "${remoteName}": ${remoteEntry.version}); verify they match manually.`,
          confidence: 'static',
        });
      } else {
        findings.push({
          severity: 'error',
          code: 'SHARED_VERSION_DRIFT',
          message: `Singleton shared dependency "${name}" resolves to different versions: host "${host.name}" has ${hostEntry.version}, remote "${remoteName}" has ${remoteEntry.version}. Align the versions (or remove singleton).`,
          confidence: 'static',
        });
      }
    }

    const verdict = rangesIntersect(
      hostEntry.requiredVersion,
      remoteEntry.requiredVersion
    );
    if (verdict === false) {
      findings.push({
        severity: 'warning',
        code: 'SHARED_RANGE_UNRESOLVABLE',
        message: `Shared dependency "${name}" declares ranges that cannot intersect: host "${host.name}" requires ${hostEntry.requiredVersion}, remote "${remoteName}" requires ${remoteEntry.requiredVersion}.`,
        confidence: 'static',
      });
    } else if (verdict === null) {
      findings.push({
        severity: 'warning',
        code: 'SHARED_RANGE_UNSUPPORTED',
        message: `Shared dependency "${name}" uses a requiredVersion this doctor cannot evaluate (host: ${hostEntry.requiredVersion}, remote "${remoteName}": ${remoteEntry.requiredVersion}); check compatibility manually.`,
        confidence: 'static',
      });
    }
  }
}

function checkNativeModules(
  host: ParsedFederationManifest,
  remoteName: string,
  remote: ParsedFederationManifest,
  findings: DoctorFinding[]
): void {
  const hostPackages = new Set(
    nativeModulesOf(host).map((entry) => entry.package)
  );
  const trusted = hostNativeListIsTrusted(host);

  for (const entry of nativeModulesOf(remote)) {
    if (hostPackages.has(entry.package)) continue;
    if (!trusted) {
      findings.push({
        severity: 'warning',
        code: 'HEURISTIC_ADVISORY',
        message:
          `Native module "${entry.package}" (${entry.version}) used by remote "${remoteName}" is not in host "${host.name}" nativeModules, ` +
          'but the host list is heuristic or incomplete (dynamic imports were detected); verify manually.',
        confidence: 'heuristic',
      });
      continue;
    }
    findings.push({
      severity: 'error',
      code: 'MISSING_NATIVE_MODULE',
      message:
        `Native module "${entry.package}" (${entry.version}) used by remote "${remoteName}" is not listed in host "${host.name}" reactNative.nativeModules. ` +
        'If the host provides this module from its app project rather than node_modules, verify manually.',
      confidence: 'static',
    });
  }
}

function checkRemoteManifests(
  input: DoctorInput,
  findings: DoctorFinding[]
): void {
  for (const remote of input.remotes) {
    if (!remote.missing) continue;
    findings.push({
      severity: input.allowMissingManifests ? 'warning' : 'error',
      code: 'MISSING_REMOTE_MANIFEST',
      message:
        `Remote "${remote.name}" has no federation manifest, so it was not checked. ` +
        'Enable `manifest: true` in its ModuleFederationPlugin config and redeploy it, or pass a local manifest file for it.',
      confidence: 'static',
    });
  }
}

function checkUnreadableManifests(
  input: DoctorInput,
  findings: DoctorFinding[]
): void {
  for (const remote of input.remotes) {
    if (!remote.corrupt) continue;
    // The adapter reason already names the resolved path; fall back to the
    // configured ref only when there is no reason to read.
    const where = remote.ref && !remote.reason ? ` (${remote.ref})` : '';
    const why = remote.reason ? `: ${remote.reason}` : '.';
    findings.push({
      severity: 'error',
      code: 'MANIFEST_UNREADABLE',
      message: `Remote "${remote.name}" has a manifest${where} that exists but could not be read${why} It was not checked; fix or regenerate that manifest.`,
      confidence: 'static',
    });
  }
}

/**
 * Compare a host manifest against a set of remote manifests and report every
 * shared-dependency, native-module and remote-cycle inconsistency found.
 * An unreadable remote manifest is a named `MANIFEST_UNREADABLE` error (exit
 * 1) and the other remotes are still checked. Only when remotes exist and
 * every one of them is unreadable does the report set
 * `unableToAnswer` (exit 2); a caller-side host failure does too, keeping
 * "no answer" distinguishable from "bad answer".
 */
export function runDoctor(input: DoctorInput): DoctorReport {
  const findings: DoctorFinding[] = [];

  checkManifestVersion(input.host, `Host "${input.host.name}"`, findings);
  for (const remote of input.remotes) {
    if (remote.missing || remote.corrupt || !remote.manifest) {
      continue;
    }
    checkManifestVersion(remote.manifest, `Remote "${remote.name}"`, findings);
    checkSharedDeps(input.host, remote.name, remote.manifest, findings);
    checkNativeModules(input.host, remote.name, remote.manifest, findings);
  }

  const cycles = detectRemoteCycles([
    { name: input.host.name, manifest: input.host },
    ...input.remotes.map((remote) => ({
      name: remote.name,
      manifest: remote.manifest,
    })),
  ]);
  findings.push(...cycles);

  checkRemoteManifests(input, findings);
  checkUnreadableManifests(input, findings);

  // Exit 2 only when remotes exist and every one is unreadable. Missing
  // remotes do not count: they keep MISSING_REMOTE_MANIFEST semantics
  // (exit 1, or 0 with `allowMissingManifests`).
  const nothingComparable =
    input.remotes.length > 0 &&
    input.remotes.every((remote) => remote.corrupt);
  return nothingComparable ? { findings, unableToAnswer: true } : { findings };
}

/**
 * Report for a run that could not answer at all (host manifest missing or
 * corrupt, missing required option). The CLI (T7) builds this instead of
 * calling `runDoctor`; exit code is 2 by construction.
 */
export function unableToAnswerReport(reason: string): DoctorReport {
  return {
    findings: [
      {
        severity: 'error',
        code: 'UNABLE_TO_ANSWER',
        message: reason,
        confidence: 'static',
      },
    ],
    unableToAnswer: true,
  };
}

function labelForSeverity(severity: DoctorFinding['severity']): string {
  return severity === 'error'
    ? 'error  '
    : severity === 'warning'
      ? 'warning'
      : 'info   ';
}

/**
 * Render a doctor report as aligned plain text (machine-stable layout; the
 * Studio/CLI presentation layers may restyle it in T7).
 */
export function formatDoctorReport(report: DoctorReport): string {
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter(
    (f) => f.severity === 'warning'
  ).length;
  const infos = report.findings.filter((f) => f.severity === 'info').length;

  if (report.findings.length === 0) return 'Doctor: no issues found.';

  const lines = [
    `Doctor: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}, ${infos} info`,
    '',
  ];
  for (const finding of report.findings) {
    lines.push(
      `${labelForSeverity(finding.severity)}  ${finding.code}  ${finding.message}`
    );
  }
  return lines.join('\n');
}

function countConfidence(
  report: DoctorReport,
  severity: DoctorFinding['severity'],
  confidence: (finding: DoctorFinding) => boolean
): number {
  return report.findings.filter(
    (f) => f.severity === severity && confidence(f)
  ).length;
}

const isHeuristic = (confidence: FindingConfidence | undefined): boolean =>
  confidence === 'heuristic';

/**
 * Serialize a doctor report as the Atlas `--json` contract
 * (.agents/skills/atlas-doctor-finding): stable key order, `exitCode`
 * mirroring the process exit code, advisories counted separately from
 * warnings. An advisory is a warning whose evidence is heuristic; every
 * other warning is static. Additive fields only relative to upstream's
 * `{ findings }` payload.
 */
export function doctorReportToJson(
  report: DoctorReport,
  exitOptions: DoctorExitCodeOptions = {}
): string {
  const advisories = countConfidence(report, 'warning', (f) =>
    isHeuristic(f.confidence)
  );
  const warnings = countConfidence(report, 'warning', (f) =>
    !isHeuristic(f.confidence)
  );
  return JSON.stringify(
    {
      tool: 'repack-atlas',
      doctorVersion: '1',
      exitCode: doctorExitCode(report, exitOptions),
      summary: {
        errors: report.findings.filter((f) => f.severity === 'error').length,
        warnings,
        advisories,
        infos: report.findings.filter((f) => f.severity === 'info').length,
      },
      findings: report.findings.map((finding) => ({
        severity: finding.severity,
        code: finding.code,
        confidence: finding.confidence ?? 'static',
        message: finding.message,
      })),
    },
    null,
    2
  );
}
