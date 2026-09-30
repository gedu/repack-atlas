// `repack-atlas doctor` through the REAL spawned bin (T7 headline evidence).
//
// Every workspace in the shared expectation table (`tests/fixtures/
// expectations.ts`) is run end-to-end: `node dist/cli.js doctor --workspace
// fixtures/<dir> --json`, asserting the process exit code AND the finding
// codes/severities in the machine payload. This is the guard that the CLI
// composition (argv → adapters → core rules → exit codes) keeps agreeing
// with the pure-core result the consistency test proves.

import assert from 'node:assert/strict';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { EXPECTATIONS } from '../fixtures/expectations.js';
import {
  binPath,
  ensureBin,
  fixturesDir,
  parseJson,
  runBin,
} from './run-bin.js';

interface JsonFinding {
  severity: string;
  code: string;
  confidence: string;
  message: string;
}

interface DoctorJson {
  tool: string;
  doctorVersion: string;
  exitCode: number;
  summary: Record<string, number>;
  findings: JsonFinding[];
}

before(ensureBin);

describe('doctor workspace mode (spawned bin)', () => {
  for (const expectation of EXPECTATIONS) {
    const workspaceArg = path.join(fixturesDir, expectation.dir);

    it(`${expectation.dir}: exit ${expectation.exitCode} + --json mirror`, async () => {
      const result = await runBin(
        'doctor',
        '--workspace',
        workspaceArg,
        '--json'
      );
      assert.equal(
        result.code,
        expectation.exitCode,
        `${expectation.dir}: process exit (stderr: ${result.stderr})`
      );
      const payload = parseJson<DoctorJson>(result.stdout);
      assert.equal(payload.tool, 'repack-atlas');
      assert.equal(payload.doctorVersion, '1');
      // The payload's exitCode mirrors the process exit code (json contract).
      assert.equal(payload.exitCode, result.code);
      assert.deepEqual(
        payload.findings
          .map((f) => ({
            code: f.code,
            severity: f.severity,
            confidence: f.confidence,
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        [...expectation.findings]
          .map((f) => ({
            code: f.code,
            severity: f.severity,
            confidence: f.confidence,
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        `${expectation.dir}: finding set in --json`
      );
      for (const finding of payload.findings) {
        assert.ok(
          finding.message.length > 0,
          `${expectation.dir}: ${finding.code} must carry a message`
        );
      }
      for (const expected of expectation.findings) {
        if (!expected.app) continue;
        assert.ok(
          payload.findings.some(
            (f) =>
              f.code === expected.code &&
              f.message.includes(`"${expected.app}"`)
          ),
          `${expectation.dir}: ${expected.code} must name "${expected.app}" (got ${JSON.stringify(payload.findings)})`
        );
      }
    });

    it(`${expectation.dir}: human output groups findings`, async () => {
      const result = await runBin('doctor', '--workspace', workspaceArg);
      assert.equal(result.code, expectation.exitCode);
      for (const finding of expectation.findings) {
        assert.ok(
          result.stdout.includes(finding.code),
          `${expectation.dir}: human output must name ${finding.code}`
        );
      }
      if (expectation.exitCode === 0 && expectation.findings.length === 0) {
        assert.ok(result.stdout.includes('no issues found'));
      }
      assert.ok(result.stdout.includes('host:'), 'source header present');
    });

    if (expectation.allowMissingExit !== undefined) {
      it(`${expectation.dir}: --allow-missing-manifests → exit ${expectation.allowMissingExit}`, async () => {
        const without = await runBin('doctor', '--workspace', workspaceArg, '--json');
        assert.equal(without.code, 1, 'baseline without the flag is exit 1');

        const withFlag = await runBin(
          'doctor',
          '--workspace',
          workspaceArg,
          '--allow-missing-manifests',
          '--json'
        );
        assert.equal(withFlag.code, expectation.allowMissingExit);
        const payload = parseJson<DoctorJson>(withFlag.stdout);
        assert.equal(payload.exitCode, withFlag.code);
        const missing = payload.findings.find(
          (f) => f.code === 'MISSING_REMOTE_MANIFEST'
        );
        assert.equal(
          missing?.severity,
          'warning',
          'flag downgrades the finding to warning'
        );
      });
    }

    if (expectation.failOnWarningsExit !== undefined) {
      it(`${expectation.dir}: --fail-on-warnings → exit ${expectation.failOnWarningsExit}`, async () => {
        const result = await runBin(
          'doctor',
          '--workspace',
          workspaceArg,
          '--fail-on-warnings',
          '--json'
        );
        assert.equal(result.code, expectation.failOnWarningsExit);
        const payload = parseJson<DoctorJson>(result.stdout);
        assert.equal(payload.exitCode, result.code);
      });
    }
  }
});

describe('doctor NOTHING_COMPARED (spawned bin)', () => {
  const nothing = path.join(fixturesDir, 'fixture-nothing-compared');
  const partial = path.join(fixturesDir, 'fixture-missing-remote-manifest');

  it('--allow-missing-manifests still exits 0 and --json carries the warning', async () => {
    const result = await runBin(
      'doctor',
      '--workspace',
      nothing,
      '--allow-missing-manifests',
      '--json'
    );
    assert.equal(result.code, 0);
    const payload = parseJson<DoctorJson>(result.stdout);
    assert.equal(payload.exitCode, 0);
    assert.deepEqual(payload.summary, {
      errors: 0,
      warnings: 3,
      advisories: 0,
      infos: 0,
    });
    const finding = payload.findings.find((f) => f.code === 'NOTHING_COMPARED');
    assert.equal(finding?.severity, 'warning');
    assert.equal(finding?.confidence, 'static');
    assert.match(finding?.message ?? '', /clean exit does not mean/);
  });

  it('without the flag the exit code stays 1 and the warning is also reported', async () => {
    const result = await runBin('doctor', '--workspace', nothing, '--json');
    assert.equal(result.code, 1);
    const payload = parseJson<DoctorJson>(result.stdout);
    assert.ok(payload.findings.some((f) => f.code === 'NOTHING_COMPARED'));
  });

  it('one compared remote means no NOTHING_COMPARED, exit codes unchanged', async () => {
    for (const [flags, code] of [
      [[], 1],
      [['--allow-missing-manifests'], 0],
    ] as const) {
      const result = await runBin(
        'doctor',
        '--workspace',
        partial,
        ...flags,
        '--json'
      );
      assert.equal(result.code, code);
      const payload = parseJson<DoctorJson>(result.stdout);
      assert.ok(!payload.findings.some((f) => f.code === 'NOTHING_COMPARED'));
    }
  });
});

describe('doctor explicit mode (spawned bin)', () => {
  const drift = path.join(fixturesDir, 'fixture-version-drift', 'manifests');

  it('--host + --remote reproduces the drift finding', async () => {
    const result = await runBin(
      'doctor',
      '--host',
      path.join(drift, 'host.json'),
      '--remote',
      path.join(drift, 'mini-store.json'),
      '--json'
    );
    assert.equal(result.code, 1);
    const payload = parseJson<DoctorJson>(result.stdout);
    assert.ok(
      payload.findings.some((f) => f.code === 'SHARED_VERSION_DRIFT'),
      `expected drift, got ${JSON.stringify(payload.findings)}`
    );
  });

  it('repeatable --remote checks every remote', async () => {
    const clean = path.join(fixturesDir, 'workspace', 'manifests');
    const result = await runBin(
      'doctor',
      '--host',
      path.join(clean, 'host.json'),
      '--remote',
      path.join(clean, 'mini-auth.json'),
      '--remote',
      path.join(clean, 'mini-store.json')
    );
    assert.equal(result.code, 0);
    // Explicit-mode display names come from the manifest file basenames.
    assert.ok(result.stdout.includes('remote: mini-auth'));
    assert.ok(result.stdout.includes('remote: mini-store'));
  });

  it('--host without --remote is a usage failure (exit 2)', async () => {
    const result = await runBin(
      'doctor',
      '--host',
      path.join(drift, 'host.json')
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--remote/);
  });

  it('a missing host manifest is exit 2, not exit 1', async () => {
    const result = await runBin(
      'doctor',
      '--host',
      path.join(fixturesDir, 'does-not-exist.json'),
      '--remote',
      path.join(drift, 'mini-auth.json')
    );
    assert.equal(result.code, 2);
  });

  it('--workspace cannot be combined with explicit refs (exit 2)', async () => {
    const result = await runBin(
      'doctor',
      '--workspace',
      fixturesDir,
      '--host',
      path.join(drift, 'host.json')
    );
    assert.equal(result.code, 2);
  });

  it('no config found walking up is exit 2', async () => {
    // /tmp has no repack-federation.json anywhere up the tree on CI or dev
    // machines; run from an absolute fixture-free path via --workspace.
    const result = await runBin('doctor', '--workspace', binPath, '--json');
    assert.equal(result.code, 2);
    const payload = parseJson<DoctorJson>(result.stdout);
    assert.equal(payload.findings[0]?.code, 'UNABLE_TO_ANSWER');
  });

  it('unknown option is exit 2', async () => {
    const result = await runBin('doctor', '--nope');
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown option --nope/);
  });
});
