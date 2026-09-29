// Findings model shared by every core rule.
//
// Provenance: the severity/code/message triple mirrors upstream
// `commands/federation/doctor.ts` (callstack/repack @ c5df67f0) so the ported
// rules keep byte-identical messages. `confidence` is an Atlas addition
// (docs/PRD.md, AGENTS.md rule 7): every finding declares whether it came from
// static analysis or a heuristic; heuristic findings are advisories, never
// errors. The JSON contract treats `confidence` as an additive field — it is
// only serialized when set, so reports for purely static runs keep the
// upstream key order.

/** How much weight a finding carries. */
export type FindingSeverity = 'error' | 'warning' | 'info';

/** Trust level of the evidence behind a finding (AGENTS.md rule 7). */
export type FindingConfidence = 'static' | 'heuristic';

/** One problem (or advisory) found while comparing manifests. */
export interface DoctorFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  /** Omitted for findings whose shape predates the confidence field. */
  confidence?: FindingConfidence;
}

/** Result of a doctor run; the caller maps it to a process exit code. */
export interface DoctorReport {
  findings: DoctorFinding[];
  /**
   * Set by the caller when the doctor could not run against usable input
   * (e.g. the host manifest is missing or corrupt). `doctorExitCode` maps it
   * to 2 — "could not answer" — distinct from 1, "ran and found errors".
   */
  unableToAnswer?: boolean;
}

/**
 * Finding codes emitted by core rules. Part of the public `--json` contract:
 * adding is fine, renaming needs a deprecation note
 * (.agents/skills/atlas-doctor-finding).
 */
export const DOCTOR_FINDING_CODES = [
  'MANIFEST_VERSION_AHEAD',
  'SINGLETON_MISMATCH',
  'EAGER_ADVISORY',
  'EAGER_MISMATCH',
  'VERSION_UNKNOWN',
  'SHARED_VERSION_DRIFT',
  'SHARED_RANGE_UNRESOLVABLE',
  'SHARED_RANGE_UNSUPPORTED',
  'HEURISTIC_ADVISORY',
  'MISSING_NATIVE_MODULE',
  'MISSING_REMOTE_MANIFEST',
  'REMOTE_CYCLE',
  'UNABLE_TO_ANSWER',
] as const;

export type DoctorFindingCode = (typeof DOCTOR_FINDING_CODES)[number];
