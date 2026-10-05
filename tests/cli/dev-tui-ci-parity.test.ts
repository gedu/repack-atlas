// Drift guard for the wizard's mirror of ink's CI detection
// (`isInkCiMode`, src/cli/dev-tui/wizard.tsx). Atlas does not import ink's
// transitive deps, so the wizard re-implements `is-in-ci`; if an ink upgrade
// ships a detection that disagrees, the resize compensation would run while
// ink is not drawing (or skip while it is) and delete real terminal rows.
// This test resolves the `is-in-ci` ink ITSELF depends on and compares its
// verdict, evaluated in a child with a clean env, to the mirror's.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { isInkCiMode } from '../../src/cli/dev-tui/wizard.js';

// From ink's resolved entry, so the lookup follows ink's own dependency
// range, not whatever version a sibling package might hoist.
const require = createRequire(import.meta.url);
const fromInk = createRequire(require.resolve('ink'));
const isInCiUrl = pathToFileURL(fromInk.resolve('is-in-ci')).href;

const CASES: readonly (readonly [string, NodeJS.ProcessEnv])[] = [
  ['no CI variables', {}],
  ['CI=1', { CI: '1' }],
  ['CI empty', { CI: '' }],
  ['CI=0', { CI: '0' }],
  ['CI=false', { CI: 'false' }],
  ['CONTINUOUS_INTEGRATION=true', { CONTINUOUS_INTEGRATION: 'true' }],
  ['CONTINUOUS_INTEGRATION=false', { CONTINUOUS_INTEGRATION: 'false' }],
  ['CI_SERVER=yes', { CI_SERVER: 'yes' }],
  ['GITLAB_CI=true', { GITLAB_CI: 'true' }],
];

function inkVerdict(caseEnv: NodeJS.ProcessEnv): boolean {
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import v from ${JSON.stringify(isInCiUrl)}; process.stdout.write(String(v))`,
    ],
    { env: { PATH: process.env.PATH, ...caseEnv }, encoding: 'utf8' }
  );
  assert.ok(out === 'true' || out === 'false', `unexpected is-in-ci output: ${out}`);
  return out === 'true';
}

describe('isInkCiMode parity with ink is-in-ci', () => {
  for (const [name, caseEnv] of CASES) {
    it(`agrees with ink on ${name}`, () => {
      assert.equal(isInkCiMode(caseEnv), inkVerdict(caseEnv));
    });
  }
});
