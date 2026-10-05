// Unit tests for the human doctor formatter (signal-to-noise contract):
// repeated codes collapse, info findings hide behind a hint that names the
// code, --show-infos and --code expand/filter, and the summary line always
// reflects the FULL report regardless of what is displayed. `--json` never
// passes through this module, so nothing here touches the machine contract.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDoctorFindings } from '../../src/cli/format.js';

interface Finding {
  severity: 'error' | 'warning' | 'info';
  code: string;
  confidence?: string;
  message: string;
}

function finding(
  severity: Finding['severity'],
  code: string,
  message: string,
  confidence?: string
): Finding {
  return { severity, code, message, ...(confidence ? { confidence } : {}) };
}

/** Repeat the same finding n times (the collapse input shape). */
function many(
  severity: Finding['severity'],
  code: string,
  message: string,
  n: number
): Finding[] {
  return Array.from({ length: n }, (_, i) => finding(severity, code, `${message} #${i}`));
}

describe('formatDoctorFindings: baseline', () => {
  it('no findings keeps the no-issues line', () => {
    assert.equal(
      formatDoctorFindings([]),
      'Doctor: no issues found.'
    );
  });

  it('a single finding prints its line unchanged', () => {
    const out = formatDoctorFindings([
      finding('error', 'MISSING_REMOTE_MANIFEST', 'remote is missing'),
    ]);
    assert.ok(out.includes('errors (1):'));
    assert.ok(
      out.includes('  MISSING_REMOTE_MANIFEST [static] remote is missing')
    );
    assert.ok(!out.includes('+ 0 more'));
    assert.ok(out.includes('summary: 1 error, 0 warnings, 0 info'));
  });

  it('summary counts everything (existing wording preserved)', () => {
    const out = formatDoctorFindings([
      finding('error', 'A_ONE', 'one'),
      finding('warning', 'B_ONE', 'two'),
      finding('warning', 'B_TWO', 'three'),
      finding('info', 'C_ONE', 'four'),
    ]);
    assert.ok(out.includes('summary: 1 error, 2 warnings, 1 info'));
  });
});

describe('formatDoctorFindings: collapse by code', () => {
  it('a code with 2 findings prints the first line then a +1 more line', () => {
    const out = formatDoctorFindings(
      many('error', 'SHARED_VERSION_DRIFT', 'drift', 2)
    );
    assert.ok(out.includes('errors (2):'), 'group count is the finding count');
    assert.ok(out.includes('drift #0'));
    assert.ok(!out.includes('drift #1'), 'second raw message is collapsed');
    assert.ok(
      out.includes(
        '  + 1 more SHARED_VERSION_DRIFT (--code SHARED_VERSION_DRIFT lists each)'
      )
    );
  });

  it('a code with many findings collapses to one +N more line', () => {
    const out = formatDoctorFindings(many('warning', 'X_DRIFT', 'w', 57));
    assert.ok(out.includes('  + 56 more X_DRIFT (--code X_DRIFT lists each)'));
    const collapsedLines = out
      .split('\n')
      .filter((l) => l.includes('more X_DRIFT'));
    assert.equal(collapsedLines.length, 1);
  });

  it('different codes in the same severity never collapse together', () => {
    const out = formatDoctorFindings([
      finding('error', 'CODE_A', 'a message'),
      finding('error', 'CODE_B', 'b message'),
    ]);
    assert.ok(out.includes('CODE_A [static] a message'));
    assert.ok(out.includes('CODE_B [static] b message'));
    assert.ok(!out.includes('more'));
  });
});

describe('formatDoctorFindings: infos hidden by default', () => {
  const infos = many('info', 'EAGER_ADVISORY', 'is eager: true on host', 4);

  it('hides info messages and prints a hint that names each code', () => {
    const out = formatDoctorFindings(infos);
    assert.ok(!out.includes('is eager: true on host'));
    assert.ok(
      out.includes('infos (4 hidden — --show-infos or --code CODE to list):')
    );
    assert.ok(out.includes('  EAGER_ADVISORY [static] × 4'));
    // Full truth survives the collapsed view.
    assert.ok(out.includes('summary: 0 errors, 0 warnings, 4 info'));
  });

  it('hint appears alongside other groups without hiding them', () => {
    const out = formatDoctorFindings([
      finding('error', 'AN_ERROR', 'bad thing'),
      ...many('info', 'INFO_A', 'a info', 2),
      ...many('info', 'INFO_B', 'b info', 1),
    ]);
    assert.ok(out.includes('AN_ERROR [static] bad thing'));
    assert.ok(out.includes('infos (3 hidden'));
    assert.ok(out.includes('  INFO_A [static] × 2'));
    assert.ok(out.includes('  INFO_B [static] × 1'));
  });

  it('--show-infos lists the info messages', () => {
    const out = formatDoctorFindings(infos, { showInfos: true });
    assert.ok(out.includes('infos (4):'));
    assert.ok(out.includes('is eager: true on host'));
    assert.ok(!out.includes('hidden'));
  });
});

describe('formatDoctorFindings: --code filter', () => {
  const mixed: Finding[] = [
    ...many('error', 'MISSING_REMOTE_MANIFEST', 'missing', 2),
    finding('warning', 'NOTHING_COMPARED', 'nothing compared'),
  ];

  it('shows only the selected code and lists each without collapsing', () => {
    const out = formatDoctorFindings(mixed, {
      codes: ['MISSING_REMOTE_MANIFEST'],
    });
    assert.ok(out.includes('missing #0'));
    assert.ok(out.includes('missing #1'), 'explicit selection lists each');
    assert.ok(!out.includes('+ 1 more'));
    assert.ok(!out.includes('NOTHING_COMPARED'));
    // Summary still reports the full truth, not the filtered view.
    assert.ok(out.includes('summary: 2 errors, 1 warning, 0 info'));
  });

  it('an explicitly selected info code shows without --show-infos', () => {
    const out = formatDoctorFindings(
      many('info', 'EAGER_ADVISORY', 'is eager: true on host', 4),
      { codes: ['EAGER_ADVISORY'] }
    );
    assert.ok(out.includes('is eager: true on host #0'));
    assert.ok(out.includes('is eager: true on host #3'));
    assert.ok(!out.includes('hidden'));
    assert.ok(out.includes('summary: 0 errors, 0 warnings, 4 info'));
  });

  it('repeatable codes keep every selected code', () => {
    const out = formatDoctorFindings(mixed, {
      codes: ['MISSING_REMOTE_MANIFEST', 'NOTHING_COMPARED'],
    });
    assert.ok(out.includes('missing #0'));
    assert.ok(out.includes('nothing compared'));
  });

  it('an unknown code matches nothing but still prints the summary', () => {
    const out = formatDoctorFindings(mixed, { codes: ['NO_SUCH_CODE'] });
    assert.ok(out.includes('doctor: no findings match the current filters.'));
    assert.ok(out.includes('summary: 2 errors, 1 warning, 0 info'));
  });
});
