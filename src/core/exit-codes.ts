// Exit-code mapping, as a pure function so the CLI (T7) stays a thin adapter.
//
// Semantics (AGENTS.md rule 6, .agents/skills/atlas-doctor-finding):
//   0  clean — warnings and advisories allowed
//   1  ran and found errors ("bad answer"), including an unreadable remote
//      manifest (`MANIFEST_UNREADABLE`) while other remotes could be checked
//   2  could not answer — the doctor never ran against usable input (host
//      unreadable, bad config, or every remote manifest unreadable)
//
// Upstream (`commands/federation/doctor.ts` @ c5df67f0) produces 0/1 here and
// lets the caller map manifest load failures to 2 outside the report. Atlas
// folds that into the pure mapping: a report carries an optional `unableToAnswer`
// flag set by the caller when input could not be obtained or parsed, keeping
// `1` and `2` distinguishable without exceptions.

import type { DoctorReport } from './findings.js';

/** Exit code 0: clean run, warnings allowed. */
export const EXIT_CLEAN = 0;
/** Exit code 1: ran and found at least one error-severity finding. */
export const EXIT_FOUND_ERRORS = 1;
/** Exit code 2: could not answer (missing/corrupt input). */
export const EXIT_NO_ANSWER = 2;

/** Opt-in escalation switches mirrored from the CLI flags. */
export interface DoctorExitCodeOptions {
  /**
   * Fail on warnings too (`doctor --fail-on-warnings`). Heuristic findings
   * never escalate — they are advisories reporting what static analysis
   * cannot check (AGENTS.md rule 7), and promoting them to gate failures
   * would punish honesty.
   */
  failOnWarnings?: boolean;
}

/**
 * Map a doctor report to a process exit code. `2` wins over `1`: an answer
 * built on partially missing input is not an answer.
 */
export function doctorExitCode(
  report: DoctorReport,
  options: DoctorExitCodeOptions = {}
): 0 | 1 | 2 {
  if (report.unableToAnswer) return EXIT_NO_ANSWER;
  if (report.findings.some((finding) => finding.severity === 'error')) {
    return EXIT_FOUND_ERRORS;
  }
  if (
    options.failOnWarnings &&
    report.findings.some(
      (finding) =>
        finding.severity === 'warning' && finding.confidence !== 'heuristic'
    )
  ) {
    return EXIT_FOUND_ERRORS;
  }
  return EXIT_CLEAN;
}
