// T6/T7 fixture expectation table — THE single source of truth.
//
// `tests/fixtures/consistency.test.ts` (pure core engine over checked-in
// manifests) and `tests/cli/doctor.test.ts` (spawned `dist/cli.js`) both
// consume this table; the fixtures/README.md and per-workspace READMEs mirror
// it (string-checked by the consistency test). Adding a fixture variant means
// adding one entry here — never a second inline copy.

export interface ExpectedFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  confidence: 'static' | 'heuristic';
}

export interface WorkspaceExpectation {
  dir: string;
  /** Every finding the doctor must report for this workspace, in no special order. */
  findings: ExpectedFinding[];
  /** Doctor exit code: 0 clean · 1 found errors · 2 could not answer. */
  exitCode: 0 | 1 | 2;
  /** True when a manifest exists but must fail to parse (exit-2 provoker). */
  corrupt?: boolean;
  /** True when a remote's manifest file was deleted from the workspace. */
  missingManifest?: boolean;
  /**
   * Expected exit code with `--allow-missing-manifests` (only meaningful
   * together with `missingManifest`).
   */
  allowMissingExit?: 0 | 1;
  /**
   * Expected exit code with `--fail-on-warnings` when it differs from the
   * default: warnings escalate to 1 unless they are heuristic advisories.
   */
  failOnWarningsExit?: 0 | 1;
}

export const EXPECTATIONS: WorkspaceExpectation[] = [
  { dir: 'workspace', findings: [], exitCode: 0 },
  {
    dir: 'fixture-remote-cycle',
    findings: [
      { code: 'REMOTE_CYCLE', severity: 'warning', confidence: 'static' },
    ],
    exitCode: 0,
    failOnWarningsExit: 1,
  },
  {
    dir: 'fixture-version-drift',
    findings: [
      {
        code: 'SHARED_VERSION_DRIFT',
        severity: 'error',
        confidence: 'static',
      },
    ],
    exitCode: 1,
  },
  {
    dir: 'fixture-missing-native',
    findings: [
      {
        code: 'MISSING_NATIVE_MODULE',
        severity: 'error',
        confidence: 'static',
      },
    ],
    exitCode: 1,
  },
  {
    dir: 'fixture-corrupt-manifest',
    findings: [],
    exitCode: 2,
    corrupt: true,
  },
  {
    dir: 'fixture-heuristic-downgrade',
    findings: [
      {
        code: 'HEURISTIC_ADVISORY',
        severity: 'warning',
        confidence: 'heuristic',
      },
    ],
    exitCode: 0,
    // Heuristic advisories never escalate under --fail-on-warnings.
    failOnWarningsExit: 0,
  },
  {
    // Studio rendering probe (T8): every hostile string sits in a name/path,
    // so the doctor stays clean while the page has to render them as text.
    dir: 'fixture-xss',
    findings: [],
    exitCode: 0,
  },
  {
    dir: 'fixture-missing-remote-manifest',
    findings: [
      {
        code: 'MISSING_REMOTE_MANIFEST',
        severity: 'error',
        confidence: 'static',
      },
    ],
    exitCode: 1,
    missingManifest: true,
    allowMissingExit: 0,
    failOnWarningsExit: 1,
  },
];
