// Exit-code mapping, as a pure function so the CLI (T7) stays a thin adapter.
//
// Semantics (AGENTS.md rule 6, .agents/skills/atlas-doctor-finding):
//   0  clean — warnings and advisories allowed
//   1  ran and found errors ("bad answer")
//   2  could not answer — the doctor never ran against usable input
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

/**
 * Map a doctor report to a process exit code. `2` wins over `1`: an answer
 * built on partially missing input is not an answer.
 */
export function doctorExitCode(report: DoctorReport): 0 | 1 | 2 {
  if (report.unableToAnswer) return EXIT_NO_ANSWER;
  return report.findings.some((finding) => finding.severity === 'error')
    ? EXIT_FOUND_ERRORS
    : EXIT_CLEAN;
}
