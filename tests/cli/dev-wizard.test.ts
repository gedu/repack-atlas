// Wizard flow unit tests over a scripted PromptPort: no terminal, no fs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  runDevWizard,
  shouldRunWizard,
  validatePortInput,
  type WizardContext,
  type WizardOutcome,
} from '../../src/cli/dev-wizard.js';
import type { FederationConfig } from '../../src/core/index.js';
import { buildDevPlan, type DevPlanEntry } from '../../src/runner/plan.js';
import { CANCEL, fakePrompts, type ScriptedAnswer } from './fake-prompts.js';

const entry = (
  key: string,
  role: 'host' | 'remote',
  declaredPort: number | null
): DevPlanEntry => ({
  key,
  name: key === 'host' ? 'host_app' : key,
  role,
  launch: { kind: 'command', command: 'run' },
  cwd: '/ws',
  declaredPort,
});

const CONTEXT: WizardContext = {
  entries: [
    entry('host', 'host', 8081),
    entry('alpha', 'remote', 8082),
    entry('beta', 'remote', null),
  ],
  standaloneRemotes: ['alpha'],
};

async function run(
  script: ScriptedAnswer[],
  context: Partial<WizardContext> = {}
) {
  const prompts = fakePrompts(script);
  const outcome = await runDevWizard(prompts, { ...CONTEXT, ...context });
  return { prompts, outcome };
}

function completed(outcome: WizardOutcome) {
  assert.equal(outcome.status, 'completed');
  return (outcome as Extract<WizardOutcome, { status: 'completed' }>).answers;
}

describe('runDevWizard', () => {
  it('walks every step in order and builds the plan inputs', async () => {
    const { prompts, outcome } = await run([
      ['alpha', 'beta'], // remotes
      'android', // platform
      true, // launch
      true, // host port
      false, // alpha: override
      '9100',
      true, // beta: automatic port
      true, // standalone alpha
    ]);
    assert.deepEqual(prompts.asked, [
      'multiselect: Which remotes to run?',
      'select: Which app platform are you running?',
      'confirm: Launch the app on android when the host is ready?',
      'confirm: Use port 8081 for host_app?',
      'confirm: Use port 8082 for alpha?',
      'text: Port for alpha:',
      'confirm: Let beta use an automatic free port?',
      'confirm: Run alpha in standalone mode?',
    ]);
    assert.deepEqual(completed(outcome), {
      apps: ['host', 'alpha', 'beta'],
      platform: 'android',
      launch: true,
      ports: { host: 8081, alpha: 9100 },
      standalone: 'alpha',
    });
    assert.equal(prompts.remaining(), 0);
  });

  it('an empty remotes answer is a host-only session, same plan as --apps host', async () => {
    const { prompts, outcome } = await run([
      [], // remotes: none
      'ios',
      false, // launch no
      true, // host port
    ]);
    assert.deepEqual(prompts.emptyHints, ['host only']);
    assert.ok(!prompts.asked.some((q) => q.includes('alpha')));
    const answers = completed(outcome);
    assert.deepEqual(answers.apps, ['host']);
    assert.equal(answers.standalone, undefined);

    const config: FederationConfig = {
      host: { manifest: './m/host.json', command: 'run host' },
      remotes: {
        alpha: { manifest: './m/alpha.json', command: 'run alpha' },
        beta: { manifest: './m/beta.json', command: 'run beta' },
      },
    };
    const plan = (apps: string[]) =>
      buildDevPlan({ config, configDir: '/ws', hostName: 'host_app', apps });
    const flagged = plan(['host']);
    assert.ok(flagged.ok);
    assert.deepEqual(plan(answers.apps), flagged);
    assert.deepEqual(
      flagged.entries.map((e) => e.key),
      ['host']
    );
  });

  it('asks ports only for the host and the selected remotes', async () => {
    const { prompts, outcome } = await run([
      ['beta'],
      'ios',
      false, // launch no
      true, // host port
      true, // beta auto
    ]);
    assert.ok(!prompts.asked.some((q) => q.includes('alpha')));
    const answers = completed(outcome);
    assert.deepEqual(answers.apps, ['host', 'beta']);
    assert.equal(answers.launch, false);
    assert.equal(answers.standalone, undefined);
  });

  it('offers standalone only for selected remotes declaring it', async () => {
    // alpha (standalone: true) not selected -> no standalone question at all.
    const { prompts } = await run([['beta'], 'ios', true, true, true]);
    assert.ok(!prompts.asked.some((q) => q.includes('standalone')));

    // beta declares no standalone either: only alpha is ever asked.
    const both = await run([['alpha', 'beta'], 'all', true, true, true, false]);
    assert.deepEqual(
      both.prompts.asked.filter((q) => q.includes('standalone')),
      ['confirm: Run alpha in standalone mode?']
    );
    assert.equal(completed(both.outcome).standalone, undefined);
  });

  it('stops asking standalone after the first yes (at most one)', async () => {
    const { prompts, outcome } = await run(
      [['a', 'b'], 'all', true, true, true, true, true],
      {
        entries: [
          entry('host', 'host', 8081),
          entry('a', 'remote', 9001),
          entry('b', 'remote', 9002),
        ],
        standaloneRemotes: ['a', 'b'],
      }
    );
    assert.deepEqual(
      prompts.asked.filter((q) => q.includes('standalone')),
      ['confirm: Run a in standalone mode?']
    );
    assert.equal(completed(outcome).standalone, 'a');
  });

  it('asks the launch question only for a single platform', async () => {
    const all = await run([['alpha'], 'all', true, true, true]);
    assert.ok(!all.prompts.asked.some((q) => q.includes('Launch')));
    assert.equal(all.prompts.notes.length, 1);
    assert.match(all.prompts.notes[0]!, /Launch skipped/);
    assert.equal(completed(all.outcome).launch, undefined);
    assert.equal(completed(all.outcome).platform, undefined);

    const ios = await run([['alpha'], 'ios', true, true, true, true]);
    assert.ok(ios.prompts.asked.some((q) => q.includes('Launch the app on ios')));
    assert.equal(ios.prompts.notes.length, 0);
  });

  it('never re-asks launch when a flag already decided it', async () => {
    const { prompts, outcome } = await run(
      [['alpha'], 'ios', true, true, true],
      { launch: true }
    );
    assert.ok(!prompts.asked.some((q) => q.includes('Launch')));
    assert.equal(completed(outcome).launch, true);
  });

  it('skips the remotes question when there are no remotes', async () => {
    const { prompts, outcome } = await run(['ios', true, true], {
      entries: [entry('host', 'host', 8081)],
      standaloneRemotes: [],
    });
    assert.ok(!prompts.asked.some((q) => q.startsWith('multiselect')));
    assert.deepEqual(completed(outcome).apps, ['host']);
  });

  it('validates a port override as an integer in 1-65535', async () => {
    const { prompts } = await run([['alpha'], 'all', true, false, '70000', true, true]);
    assert.equal(prompts.validations.length, 1);
    assert.match(prompts.validations[0]!, /1 and 65535/);
    for (const bad of ['0', '65536', '80.5', 'abc', '', '0x50', '1e3']) {
      assert.match(validatePortInput(bad)!, /1 and 65535/, bad);
    }
    for (const good of ['1', '8081', '65535']) {
      assert.equal(validatePortInput(good), undefined, good);
    }
  });

  it('preselects the --platform flag and "all" otherwise', async () => {
    const seen: Array<string | undefined> = [];
    const spy = (prompts: ReturnType<typeof fakePrompts>) => {
      const select = prompts.select.bind(prompts);
      prompts.select = (question) => {
        seen.push(question.initialValue);
        return select(question);
      };
      return prompts;
    };
    await runDevWizard(
      spy(fakePrompts([['alpha'], 'ios', true, true, true, true])),
      { ...CONTEXT, platform: 'android' }
    );
    await runDevWizard(spy(fakePrompts(['all', true, true])), {
      entries: [entry('host', 'host', 8081)],
      standaloneRemotes: [],
    });
    assert.deepEqual(seen, ['android', 'all']);
  });

  it('preselects every remote in the multiselect', async () => {
    let initial: string[] | undefined;
    const prompts = fakePrompts([['alpha'], 'all', true, true, true]);
    const multiselect = prompts.multiselect.bind(prompts);
    prompts.multiselect = (question) => {
      initial = question.initialValues;
      return multiselect(question);
    };
    await runDevWizard(prompts, CONTEXT);
    assert.deepEqual(initial, ['alpha', 'beta']);
  });

  it('does not offer "all" when --launch is set', async () => {
    let values: string[] = [];
    let initial: string | undefined;
    const prompts = fakePrompts([['alpha'], 'ios', true, true, true]);
    const select = prompts.select.bind(prompts);
    prompts.select = (question) => {
      values = question.options.map((option) => option.value);
      initial = question.initialValue;
      return select(question);
    };
    const outcome = await runDevWizard(prompts, {
      ...CONTEXT,
      launch: true,
      platform: 'ios',
    });
    assert.deepEqual(values, ['ios', 'android']);
    assert.equal(initial, 'ios');
    assert.equal(completed(outcome).launch, true);
    assert.equal(completed(outcome).platform, 'ios');
  });

  // A cancel at step N: the previous steps were asked, nothing after, and the
  // outcome is `cancelled` with one announcement.
  const FULL_PATH: ScriptedAnswer[] = [
    ['alpha', 'beta'],
    'ios',
    true,
    true,
    false,
    '9100',
    true,
    true,
  ];
  const STEP_NAMES = [
    'remotes',
    'platform',
    'launch',
    'host port',
    'alpha port confirm',
    'alpha port text',
    'beta port',
    'standalone',
  ];
  STEP_NAMES.forEach((step, index) => {
    it(`cancelling at the ${step} step stops the flow`, async () => {
      const script: ScriptedAnswer[] = [...FULL_PATH.slice(0, index), CANCEL];
      const { prompts, outcome } = await run(script);
      assert.deepEqual(outcome, { status: 'cancelled' });
      assert.equal(prompts.asked.length, index + 1);
      assert.deepEqual(prompts.cancels, ['Session cancelled.']);
    });
  });
});

describe('shouldRunWizard', () => {
  const base = {
    hasApps: false,
    noInteractive: false,
    json: false,
    stdoutIsTTY: true,
    stdinIsTTY: true,
  };
  it('runs for a human on a TTY who has not decided', () => {
    assert.equal(shouldRunWizard(base), true);
  });
  it('is suppressed by --apps, --no-interactive/--ci, --json and non-TTYs', () => {
    assert.equal(shouldRunWizard({ ...base, hasApps: true }), false);
    assert.equal(shouldRunWizard({ ...base, noInteractive: true }), false);
    assert.equal(shouldRunWizard({ ...base, json: true }), false);
    assert.equal(shouldRunWizard({ ...base, stdoutIsTTY: false }), false);
    assert.equal(shouldRunWizard({ ...base, stdinIsTTY: false }), false);
  });
});
