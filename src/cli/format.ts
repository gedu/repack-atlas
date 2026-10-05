// Human-readable rendering for CLI output. The core formatters
// (formatDoctorReport/formatManifest) stay generic; the grouping the T7 spec
// asks for (findings by severity + summary line) is presentation, so it
// lives here. So does the signal-to-noise pass: collapsing repeated codes and
// hiding info findings behind a hint is presentation only, never a change to
// the report itself. The `--json` payload is produced in core and never
// passes through this module, so it can never be filtered or collapsed.

interface DisplayFinding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  confidence?: string;
  message: string;
}

export interface DoctorDisplayOptions {
  /** List info-severity findings instead of collapsing them into a hint. */
  showInfos?: boolean;
  /** Explicitly selected codes: only these are listed, each one individually. */
  codes?: string[] | undefined;
}

/** Render findings grouped by severity: errors, warnings, infos. */
export function formatDoctorFindings(
  findings: DisplayFinding[],
  options: DoctorDisplayOptions = {}
): string {
  if (findings.length === 0) return 'Doctor: no issues found.';

  const selected = options.codes?.length
    ? new Set(options.codes)
    : undefined;
  // Explicit selection wins over the hide-infos default.
  const shown = selected
    ? findings.filter((f) => selected.has(f.code))
    : findings;
  const hiddenInfos = shown.filter((f) => f.severity === 'info');
  const infosVisible = selected !== undefined || options.showInfos === true;

  const lines: string[] = [];
  const groups: [string, 'error' | 'warning' | 'info'][] = [
    ['errors', 'error'],
    ['warnings', 'warning'],
    ['infos', 'info'],
  ];
  for (const [label, severity] of groups) {
    const group = shown.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    if (severity === 'info' && !infosVisible) continue;
    lines.push(`${label} (${group.length}):`);
    // Collapse by code: one line per code, then a "+N more" line. An
    // explicitly selected code is listed finding by finding.
    for (const code of [...new Set(group.map((f) => f.code))]) {
      const repeated = group.filter((f) => f.code === code);
      for (const finding of selected?.has(code) ? repeated : repeated.slice(0, 1)) {
        lines.push(
          `  ${finding.code} [${finding.confidence ?? 'static'}] ${finding.message}`
        );
      }
      const extra = repeated.length - 1;
      if (extra > 0 && !(selected?.has(code) ?? false)) {
        lines.push(`  + ${extra} more ${code} (--code ${code} lists each)`);
      }
    }
    lines.push('');
  }

  // Hidden infos are not dropped from the picture: the hint names every code
  // and how many findings sit behind it.
  if (!infosVisible && hiddenInfos.length > 0) {
    lines.push(
      `infos (${hiddenInfos.length} hidden — --show-infos or --code CODE to list):`
    );
    for (const code of [...new Set(hiddenInfos.map((f) => f.code))]) {
      const hidden = hiddenInfos.filter((f) => f.code === code);
      lines.push(
        `  ${code} [${hidden[0]?.confidence ?? 'static'}] × ${hidden.length}`
      );
    }
    lines.push('');
  } else if (shown.length === 0) {
    lines.push('doctor: no findings match the current filters.');
    lines.push('');
  }

  // The summary is the full truth, never the filtered view — exit codes are
  // computed from the same full report.
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const infos = findings.filter((f) => f.severity === 'info').length;
  lines.push(
    `summary: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}, ${infos} info`
  );
  return lines.join('\n');
}
