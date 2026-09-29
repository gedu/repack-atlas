// Human-readable rendering for CLI output. The core formatters
// (formatDoctorReport/formatManifest) stay generic; the grouping the T7 spec
// asks for (findings by severity + summary line) is presentation, so it
// lives here.

/** Render findings grouped by severity: errors, warnings, infos. */
export function formatDoctorFindings(
  findings: {
    severity: 'error' | 'warning' | 'info';
    code: string;
    confidence?: string;
    message: string;
  }[]
): string {
  if (findings.length === 0) return 'Doctor: no issues found.';

  const groups: [string, ('error' | 'warning' | 'info')[]][] = [
    ['errors', ['error']],
    ['warnings', ['warning']],
    ['infos', ['info']],
  ];
  const lines: string[] = [];
  for (const [label, severities] of groups) {
    const group = findings.filter((f) => severities.includes(f.severity));
    if (group.length === 0) continue;
    lines.push(`${label} (${group.length}):`);
    for (const finding of group) {
      const confidence = finding.confidence ?? 'static';
      lines.push(
        `  ${finding.code} [${confidence}] ${finding.message}`
      );
    }
    lines.push('');
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const infos = findings.filter((f) => f.severity === 'info').length;
  lines.push(
    `summary: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}, ${infos} info`
  );
  return lines.join('\n');
}
