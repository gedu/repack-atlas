// Ported upstream doctor tests: `packages/repack/src/commands/federation/
// __tests__/doctor.test.ts` of callstack/repack @ c5df67f0, converted from
// jest to node:test. Fixtures are verbatim copies under
// tests/fixtures/core/ (see its README). Assertions and expectations are
// unchanged; only the harness and import paths differ. Atlas additions:
// REMOTE_CYCLE integration and corrupt-manifest (exit 2) tests at the bottom.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  doctorReportToJson,
  formatDoctorReport,
  runDoctor,
} from '../../src/core/doctor.js';
import { doctorExitCode } from '../../src/core/exit-codes.js';
import { rangesIntersect } from '../../src/core/semverRange.js';
import type { ParsedFederationManifest } from '../../src/core/manifest-types.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'core'
);

function loadFixture(name: string): ParsedFederationManifest {
  return JSON.parse(
    readFileSync(path.join(fixturesDir, `${name}.json`), 'utf-8')
  ) as ParsedFederationManifest;
}

const host = loadFixture('host');
const remoteClean = loadFixture('remote-clean');
const remoteConflicting = loadFixture('remote-conflicting');

function clone(manifest: ParsedFederationManifest): ParsedFederationManifest {
  return JSON.parse(JSON.stringify(manifest)) as ParsedFederationManifest;
}

function codes(report: ReturnType<typeof runDoctor>): string[] {
  return report.findings.map((finding) => finding.code);
}

function findingFor(code: string) {
  const report = runDoctor({
    host,
    remotes: [{ name: 'store', manifest: remoteConflicting }],
  });
  const finding = report.findings.find((entry) => entry.code === code);
  if (!finding) throw new Error(`No ${code} finding in ${codes(report)}`);
  return finding;
}

describe('runDoctor', () => {
  it('reports nothing for a matching host and remote', () => {
    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: remoteClean }],
    });

    assert.deepEqual(report.findings, []);
    assert.equal(doctorExitCode(report), 0);
  });

  it('flags a singleton version drift naming both versions', () => {
    const finding = findingFor('SHARED_VERSION_DRIFT');

    assert.equal(finding.severity, 'error');
    assert.ok(finding.message.includes('react'));
    assert.ok(finding.message.includes('19.0.0'));
    assert.ok(finding.message.includes('19.1.0'));
    assert.ok(finding.message.includes('shell'));
    assert.ok(finding.message.includes('store'));
  });

  it('warns when declared ranges cannot intersect', () => {
    const finding = findingFor('SHARED_RANGE_UNRESOLVABLE');

    assert.equal(finding.severity, 'warning');
    assert.ok(finding.message.includes('react-native'));
    assert.ok(finding.message.includes('~0.79.2'));
    assert.ok(finding.message.includes('~0.74.5'));
  });

  it('flags a singleton mismatch as error and the conventional eager mismatch as an advisory', () => {
    const singleton = findingFor('SINGLETON_MISMATCH');
    assert.equal(singleton.severity, 'error');
    assert.ok(singleton.message.includes('true'));
    assert.ok(singleton.message.includes('false'));

    // The conflicting fixture puts react-native eager: true on the host and
    // eager: false on the remote — the expected host-eager/remote-lazy
    // convention — so it is an advisory, not an error.
    const eager = findingFor('EAGER_ADVISORY');
    assert.equal(eager.severity, 'warning');
    assert.ok(eager.message.includes('true'));
    assert.ok(eager.message.includes('false'));
    assert.ok(eager.message.includes('host-eager/remote-lazy convention'));

    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: remoteConflicting }],
    });
    assert.ok(!codes(report).includes('EAGER_MISMATCH'));
  });

  it('errors on a reverse eager mismatch keeping the legacy message byte-identical', () => {
    const lazyHost = clone(host);
    const eagerRemote = clone(remoteConflicting);
    // react-native: host eager: false against remote eager: true — no
    // convention orders this; it stays the legacy EAGER_MISMATCH error.
    lazyHost.shared![1]!.eager = false;
    eagerRemote.shared![1]!.eager = true;

    const report = runDoctor({
      host: lazyHost,
      remotes: [{ name: 'store', manifest: eagerRemote }],
    });

    const eager = report.findings.find(
      (finding) => finding.code === 'EAGER_MISMATCH'
    );
    assert.equal(eager?.severity, 'error');
    assert.equal(
      eager?.message,
      'Shared dependency "react-native" is eager: false on host "shell" but true on remote "store".'
    );
    assert.ok(!codes(report).includes('EAGER_ADVISORY'));
  });

  it('exits 0 when the conventional eager advisory is the only finding', () => {
    const lazyRemote = clone(remoteClean);
    lazyRemote.shared![0]!.eager = false;

    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: lazyRemote }],
    });

    assert.deepEqual(codes(report), ['EAGER_ADVISORY']);
    assert.equal(doctorExitCode(report), 0);
  });

  it('errors when a remote native module is absent from a trusted host list', () => {
    const finding = findingFor('MISSING_NATIVE_MODULE');

    assert.equal(finding.severity, 'error');
    assert.ok(finding.message.includes('react-native-maps'));
    assert.ok(finding.message.includes('store'));
    assert.match(
      finding.message,
      /if the host provides this module from its app project rather than node_modules, verify manually/iu
    );
  });

  it('downgrades the native-module finding to an advisory when the host uses dynamic imports', () => {
    const dynamicHost = clone(host);
    dynamicHost.reactNative!.dynamicImportDetected = true;

    const report = runDoctor({
      host: dynamicHost,
      remotes: [{ name: 'store', manifest: remoteConflicting }],
    });

    assert.ok(!codes(report).includes('MISSING_NATIVE_MODULE'));
    assert.ok(codes(report).includes('HEURISTIC_ADVISORY'));
    const advisory = report.findings.find(
      (finding) => finding.code === 'HEURISTIC_ADVISORY'
    );
    assert.equal(advisory?.severity, 'warning');
    assert.ok(advisory?.message.includes('verify manually'));
  });

  it('downgrades the native-module finding when the host list is heuristic', () => {
    const heuristicHost = clone(host);
    heuristicHost.reactNative!.nativeModules![0]!.confidence = 'heuristic';

    const report = runDoctor({
      host: heuristicHost,
      remotes: [{ name: 'store', manifest: remoteConflicting }],
    });

    assert.ok(!codes(report).includes('MISSING_NATIVE_MODULE'));
    assert.ok(codes(report).includes('HEURISTIC_ADVISORY'));
  });

  it('notes an unknown singleton version without failing', () => {
    const unknownRemote = clone(remoteClean);
    unknownRemote.shared![0]!.version = 'unknown';

    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: unknownRemote }],
    });

    assert.ok(codes(report).includes('VERSION_UNKNOWN'));
    assert.equal(doctorExitCode(report), 0);
  });

  it('errors on a missing remote manifest, warning when allowed', () => {
    const strict = runDoctor({
      host,
      remotes: [{ name: 'payments', missing: true }],
    });
    const missing = strict.findings.find(
      (finding) => finding.code === 'MISSING_REMOTE_MANIFEST'
    );
    assert.equal(missing?.severity, 'error');
    assert.ok(missing?.message.includes('payments'));
    assert.ok(missing?.message.includes('manifest: true'));
    assert.equal(doctorExitCode(strict), 1);

    const lenient = runDoctor({
      host,
      remotes: [{ name: 'payments', missing: true }],
      allowMissingManifests: true,
    });
    assert.equal(
      lenient.findings.find(
        (finding) => finding.code === 'MISSING_REMOTE_MANIFEST'
      )?.severity,
      'warning'
    );
    assert.equal(doctorExitCode(lenient), 0);
  });

  it('warns about a newer manifest version but keeps comparing', () => {
    const newerRemote = clone(remoteClean);
    newerRemote.manifestVersion = 2;

    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: newerRemote }],
    });

    const versionFinding = report.findings.find(
      (finding) => finding.code === 'MANIFEST_VERSION_AHEAD'
    );
    assert.equal(versionFinding?.severity, 'warning');
    assert.ok(versionFinding?.message.includes('2'));
    // Comparison still ran: no spurious errors were introduced.
    assert.equal(doctorExitCode(report), 0);
  });

  it('maps any error finding to exit code 1', () => {
    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: remoteConflicting }],
    });

    assert.equal(doctorExitCode(report), 1);
  });
});

describe('doctor report rendering', () => {
  it('renders a clean summary and lists findings with their codes', () => {
    const clean = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: remoteClean }],
    });
    assert.ok(formatDoctorReport(clean).includes('no issues found'));

    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: remoteConflicting }],
    });
    const text = formatDoctorReport(report);
    assert.ok(text.includes('SHARED_VERSION_DRIFT'));
    assert.ok(text.includes('error'));
  });

  it('serializes findings with a stable key order', () => {
    const report = runDoctor({
      host,
      remotes: [{ name: 'store', manifest: remoteConflicting }],
    });

    const parsed = JSON.parse(doctorReportToJson(report)) as {
      findings: Array<Record<string, unknown>>;
    };
    for (const finding of parsed.findings) {
      assert.deepEqual(Object.keys(finding), [
        'severity',
        'code',
        'confidence',
        'message',
      ]);
    }
  });
});

describe('rangesIntersect', () => {
  const cases: Array<[string, string, boolean]> = [
    // caret
    ['^15.0.0', '^15.4.0', true],
    ['^15.0.0', '^16.0.0', false],
    ['^0.74.5', '^0.74.9', true],
    ['^0.74.5', '^0.75.0', false],
    ['^0.0.3', '^0.0.4', false],
    // tilde
    ['~0.74.5', '~0.74.9', true],
    ['~0.74.5', '~0.75.0', false],
    ['~1.2.3', '~1.3.0', false],
    // exact
    ['19.0.0', '19.0.0', true],
    ['19.0.0', '19.0.1', false],
    ['19.0.0', '^19.0.0', true],
    ['19.0.0', '^18.0.0', false],
    // gte
    ['>=18', '19.0.0', true],
    ['>=18', '17.9.9', false],
    ['>=18', '>=20', true],
    // x-ranges
    ['19.x', '19.4.0', true],
    ['19.x', '20.0.0', false],
    ['19.x', '19.x', true],
    ['*', '^1.0.0', true],
  ];
  for (const [a, b, expected] of cases) {
    it(`${a} vs ${b} -> ${expected}`, () => {
      assert.equal(rangesIntersect(a, b), expected);
    });
  }

  const unsupported: Array<[string, string]> = [
    ['^15.x', '15.0.0'],
    ['15.0.0 || 16.0.0', '^15.0.0'],
    ['15.0.0 - 16.0.0', '^15.0.0'],
    ['>15', '15.0.0'],
  ];
  for (const [a, b] of unsupported) {
    it(`returns null for unsupported syntax ${a}`, () => {
      assert.equal(rangesIntersect(a, b), null);
    });
  }
});

describe('runDoctor REMOTE_CYCLE integration and exit-code 2 (Atlas additions)', () => {
  it('surfaces REMOTE_CYCLE warnings for cross-remote cycles in the doctor report', () => {
    const report = runDoctor({
      host,
      remotes: [
        {
          name: 'store',
          manifest: {
            manifestVersion: 1,
            id: 'store',
            name: 'store',
            remotes: [{ alias: 'auth', entry: '', federationContainerName: 'auth', moduleName: 'auth' }],
          },
        },
        {
          name: 'auth',
          manifest: {
            manifestVersion: 1,
            id: 'auth',
            name: 'auth',
            remotes: [{ alias: 'store', entry: '', federationContainerName: 'store', moduleName: 'store' }],
          },
        },
      ],
    });

    const cycles = report.findings.filter(
      (finding) => finding.code === 'REMOTE_CYCLE'
    );
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0]!.severity, 'warning');
    assert.ok(cycles[0]!.message.includes('auth -> store -> auth'));
    // Warning severity keeps the exit code at 0.
    assert.equal(doctorExitCode(report), 0);
  });

  it('marks the report unable to answer for a corrupt remote manifest (exit 2)', () => {
    const report = runDoctor({
      host,
      remotes: [
        {
          name: 'payments',
          corrupt: true,
        },
        { name: 'store', manifest: remoteConflicting },
      ],
    });

    // Findings from the readable remote are still reported (best effort)…
    assert.ok(codes(report).includes('SHARED_VERSION_DRIFT'));
    // …but the answer is flagged incomplete: exit 2, not 1.
    assert.equal(doctorExitCode(report), 2);
  });
});
