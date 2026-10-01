// Pure contract of the ink wizard's state machine (`src/cli/dev-tui/wizard-model.ts`,
// G5 "wizard-in-TUI"). No terminal, no ink, no react — the whole interaction
// surface asserted as data: how a question opens, what each keystroke does to
// it, when an answer is accepted, and what the recap line says. The ink layer
// (`wizard.tsx`) is only the mapping of real bytes onto `handleKey`, so proving
// the contract here plus the render smoke in dev-tui-wizard-app.test.tsx covers
// the wizard without a pty.
//
// Purity is asserted the way dev-tui-seam.test.ts checks model.ts/banner.ts: if
// this file ever needs a terminal, the machine stopped being pure.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { PromptOption } from '../../src/core/index.js';
import {
  EMPTY_SELECTION_ERROR,
  answerText,
  backspaceDraft,
  createWizardController,
  helpText,
  moveCursor,
  openField,
  recapText,
  setConfirmed,
  setDraft,
  selectionValues,
  submitField,
  toggleFocused,
  type WizardField,
  type WizardRequest,
} from '../../src/cli/dev-tui/wizard-model.js';
import { repoRoot } from './run-bin.js';

const OPTIONS: readonly PromptOption[] = [
  { value: 'mini_auth', label: 'mini_auth' },
  { value: 'mini_store', label: 'mini_store' },
  { value: 'mini_cart', label: 'mini_cart' },
];

// Overrides spelled with `| undefined` so a test can pass
// `{ initialValues: undefined }` under exactOptionalPropertyTypes.
type MultiselectOverrides = {
  initialValues?: string[] | undefined;
  emptyHint?: string | undefined;
};

// Every remote preselected unless the test says otherwise (the wizard always
// asks that way); an explicit `initialValues: undefined` means "not provided".
const multiselectRequest = (
  overrides: MultiselectOverrides = {}
): WizardRequest => ({
  kind: 'multiselect',
  message: 'Which remotes to run?',
  options: OPTIONS,
  ...(Object.hasOwn(overrides, 'initialValues')
    ? overrides.initialValues === undefined
      ? {}
      : { initialValues: overrides.initialValues }
    : { initialValues: OPTIONS.map((option) => option.value) }),
  ...(overrides.emptyHint === undefined
    ? {}
    : { emptyHint: overrides.emptyHint }),
});

/** A field with every slot filled, for the transitions that ignore kind. */
const field = (overrides: Partial<WizardField> = {}): WizardField => ({
  ...openField(multiselectRequest()),
  ...overrides,
});

describe('wizard model: openField', () => {
  it('pre-ticks only initialValues the question actually offered', () => {
    const opened = openField(
      multiselectRequest({ initialValues: ['mini_store', 'not-a-remote'] })
    );
    assert.deepEqual(opened.selected, ['mini_store']);
    assert.equal(opened.cursor, 0);
    assert.equal(opened.error, undefined);
  });

  it('keeps option order for the selection and starts unselected with no initialValues', () => {
    assert.deepEqual(
      openField(multiselectRequest({ initialValues: undefined })).selected,
      []
    );
    const opened = openField(multiselectRequest({ initialValues: ['mini_cart', 'mini_auth'] }));
    assert.deepEqual(opened.selected, ['mini_auth', 'mini_cart']);
  });

  it('focuses the matching option of a select, and the first when it is absent', () => {
    const platform: WizardRequest = {
      kind: 'select',
      message: 'Which app platform are you running?',
      options: [
        { value: 'ios', label: 'iOS' },
        { value: 'android', label: 'Android' },
        { value: 'all', label: 'All / decide later' },
      ],
      initialValue: 'android',
    };
    assert.equal(openField(platform).cursor, 1);
    assert.equal(
      openField({ ...platform, initialValue: 'watchos' }).cursor,
      0,
      'an unknown preselection must not read past the list'
    );
  });

  it('takes the confirm default and leaves options empty', () => {
    assert.equal(
      openField({ kind: 'confirm', message: 'Ship it?' }).confirmed,
      true
    );
    const no = openField({
      kind: 'confirm',
      message: 'Ship it?',
      initialValue: false,
    });
    assert.equal(no.confirmed, false);
    assert.deepEqual(no.options, [], 'the y/n pair is drawn, not offered');
  });

  it('carries the text validator and an empty draft', () => {
    const validate = (value: string): string | undefined =>
      value === '' ? 'needed' : undefined;
    const opened = openField({ kind: 'text', message: 'Port:', validate });
    assert.equal(opened.draft, '');
    assert.equal(opened.validate?.(''), 'needed');
    assert.equal(openField({ kind: 'text', message: 'Port:' }).validate, undefined);
  });
});

describe('wizard model: cursor and selection', () => {
  it('clamps the cursor at both ends instead of wrapping', () => {
    const opened = openField(multiselectRequest());
    assert.equal(moveCursor(opened, -1).cursor, 0, 'top stays put');
    const bottom = moveCursor(opened, 5);
    assert.equal(bottom.cursor, OPTIONS.length - 1);
    assert.equal(moveCursor(bottom, 1).cursor, OPTIONS.length - 1, 'bottom stays put');
  });

  it('leaves the field untouched when the cursor cannot move', () => {
    const opened = openField(multiselectRequest());
    assert.equal(moveCursor(opened, -1), opened, 'no-op must not copy the field');
    assert.equal(moveCursor(openField({ kind: 'text', message: 'Port:' }), 1).cursor, 0);
  });

  it('toggles the focused option in option order, never click order', () => {
    let opened = openField(
      multiselectRequest({ initialValues: ['mini_auth', 'mini_store'] })
    );
    opened = moveCursor(opened, 2); // focus mini_cart
    opened = toggleFocused(opened);
    assert.deepEqual(opened.selected, ['mini_auth', 'mini_store', 'mini_cart']);
    opened = moveCursor(opened, -2); // back to mini_auth
    opened = toggleFocused(opened);
    assert.deepEqual(opened.selected, ['mini_store', 'mini_cart']);
    assert.deepEqual(selectionValues(opened), ['mini_store', 'mini_cart']);
  });

  it('ignores the toggle on a kind that has no checkboxes', () => {
    const confirm = openField({ kind: 'confirm', message: 'Ship it?' });
    assert.equal(toggleFocused(confirm), confirm);
    const select = openField({
      kind: 'select',
      message: 'Platform?',
      options: OPTIONS,
    });
    assert.equal(toggleFocused(select), select);
  });
});

describe('wizard model: draft and confirm', () => {
  it('clears a stale error as soon as the user types again', () => {
    const rejected: WizardField = {
      ...openField({ kind: 'text', message: 'Port:' }),
      error: 'Enter an integer port between 1 and 65535.',
    };
    assert.equal(setDraft(rejected, '80').error, undefined);
    assert.equal(backspaceDraft(setDraft(rejected, '808')).draft, '80');
  });

  it('flips or sets the confirm answer', () => {
    const opened = openField({ kind: 'confirm', message: 'Ship it?' });
    assert.equal(setConfirmed(opened).confirmed, false);
    assert.equal(setConfirmed(setConfirmed(opened)).confirmed, true);
    assert.equal(setConfirmed(opened, false).confirmed, false);
    assert.equal(setConfirmed(opened, true).confirmed, true);
  });
});

describe('wizard model: submitField', () => {
  it('rejects an empty multiselect with the standing message', () => {
    const empty = field({ selected: [] });
    const submit = submitField(empty);
    assert.equal(submit.status, 'invalid');
    if (submit.status === 'invalid') {
      assert.equal(submit.field.error, EMPTY_SELECTION_ERROR);
    }
  });

  it('accepts an empty multiselect when an emptyHint makes it meaningful', () => {
    const submit = submitField(field({ selected: [], emptyHint: 'host only' }));
    assert.deepEqual(submit, { status: 'ok', value: [] });
  });

  it('answers a select with the focused value and a confirm with its boolean', () => {
    const select = moveCursor(
      openField({ kind: 'select', message: 'Platform?', options: OPTIONS }),
      2
    );
    assert.deepEqual(submitField(select), { status: 'ok', value: 'mini_cart' });
    assert.deepEqual(
      submitField(openField({ kind: 'confirm', message: 'Ship it?' })),
      { status: 'ok', value: true }
    );
  });

  it('keeps a text question open showing the validator message', () => {
    const validate = (value: string): string | undefined =>
      /^\d+$/.test(value) ? undefined : 'Enter an integer port between 1 and 65535.';
    const asked = openField({ kind: 'text', message: 'Port:', validate });
    const submit = submitField(setDraft(asked, 'nope'));
    assert.equal(submit.status, 'invalid');
    if (submit.status === 'invalid') {
      assert.match(submit.field.error ?? '', /integer port/);
      assert.equal(submit.field.draft, 'nope', 'what was typed stays on screen');
    }
    assert.deepEqual(submitField(setDraft(asked, ' 9001 ')), {
      status: 'ok',
      value: '9001',
    });
  });
});

describe('wizard model: recap wording', () => {
  const multiselect = openField(
    multiselectRequest({ emptyHint: 'host only', initialValues: [] })
  );

  it('joins multiselect labels and falls back to the emptyHint', () => {
    assert.equal(
      answerText({ ...multiselect, selected: ['mini_auth', 'mini_cart'] }, [
        'mini_auth',
        'mini_cart',
      ]),
      'mini_auth, mini_cart'
    );
    assert.equal(answerText(multiselect, []), 'host only');
    assert.equal(
      answerText({ ...multiselect, emptyHint: undefined }, []),
      'none'
    );
  });

  it('says yes/no, the option label, or the typed text', () => {
    const confirm = openField({ kind: 'confirm', message: 'Ship it?' });
    assert.equal(answerText(confirm, true), 'yes');
    assert.equal(answerText(confirm, false), 'no');
    const select = openField({
      kind: 'select',
      message: 'Platform?',
      options: [{ value: 'ios', label: 'iOS' }],
    });
    assert.equal(answerText(select, 'ios'), 'iOS');
    assert.equal(
      answerText(openField({ kind: 'text', message: 'Port:' }), '9001'),
      '9001'
    );
  });

  it('prefixes the question and marks a cancel', () => {
    const confirm = openField({ kind: 'confirm', message: 'Ship it?' });
    assert.equal(recapText(confirm, { status: 'ok', value: true }), 'Ship it? yes');
    assert.equal(
      recapText(confirm, { status: 'cancelled' }),
      'Ship it? cancelled'
    );
  });

  it('offers the empty option in the multiselect help line only when allowed', () => {
    assert.match(helpText(multiselect), /clear all for host only/);
    assert.doesNotMatch(
      helpText(openField(multiselectRequest({ emptyHint: undefined }))),
      /clear all/
    );
    assert.match(
      helpText(openField({ kind: 'confirm', message: 'Ship it?' })),
      /^y\/n/
    );
  });
});

describe('wizard model: controller keystrokes', () => {
  const settled = async (
    promise: Promise<unknown>
  ): Promise<unknown> => await promise;

  it('opens a question, moves with arrows and j/k, and answers on enter', async () => {
    const controller = createWizardController();
    const answer = controller.ask(
      multiselectRequest({ initialValues: [], emptyHint: 'host only' })
    );
    assert.equal(controller.state().field?.kind, 'multiselect');
    controller.handleKey('', { downArrow: true });
    controller.handleKey('j', {});
    assert.equal(controller.state().field?.cursor, 2);
    controller.handleKey('k', {});
    controller.handleKey('', { upArrow: true });
    assert.equal(controller.state().field?.cursor, 0);
    assert.equal(
      controller.state().lines.length,
      0,
      'nothing is settled until enter'
    );
    controller.handleKey('', { return: true });
    // Nothing ticked, and the emptyHint makes that a real answer (host-only
    // session) — the same plan input `--apps host` produces.
    assert.deepEqual(await settled(answer), { status: 'ok', value: [] });
    assert.equal(controller.state().field, null);
    assert.deepEqual(
      controller.state().lines.map((line) => [line.tone, line.text]),
      [['recap', 'Which remotes to run? host only']]
    );
  });

  it('toggles with space and answers y/n on a confirm', async () => {
    const controller = createWizardController();
    const remotes = controller.ask(multiselectRequest());
    controller.handleKey(' ', {}); // untick the focused remote
    assert.deepEqual(controller.state().field?.selected, [
      'mini_store',
      'mini_cart',
    ]);
    controller.handleKey('', { return: true });
    assert.deepEqual(await settled(remotes), {
      status: 'ok',
      value: ['mini_store', 'mini_cart'],
    });

    const confirm = controller.ask({ kind: 'confirm', message: 'Ship it?' });
    controller.handleKey('n', {});
    assert.deepEqual(await settled(confirm), { status: 'ok', value: false });

    const second = controller.ask({ kind: 'confirm', message: 'Ship it?' });
    controller.handleKey(' ', {}); // space toggles what is drawn
    assert.equal(controller.state().field?.confirmed, false);
    controller.handleKey('', { return: true });
    assert.deepEqual(await settled(second), { status: 'ok', value: false });

    const third = controller.ask({
      kind: 'confirm',
      message: 'Ship it?',
      initialValue: false,
    });
    controller.handleKey('y', {});
    assert.deepEqual(await settled(third), { status: 'ok', value: true });
  });

  it('types into a text draft, trims with backspace, and ignores control bytes', async () => {
    const controller = createWizardController();
    const port = controller.ask({ kind: 'text', message: 'Port:' });
    controller.handleKey('90', {});
    controller.handleKey('0', {});
    assert.equal(controller.state().field?.draft, '900');
    controller.handleKey('', { backspace: true });
    assert.equal(controller.state().field?.draft, '90');
    // A control byte is a keystroke, not text (raw mode would otherwise put a
    // tab or a BEL in the port number).
    controller.handleKey('\t', {});
    controller.handleKey('', {}); // ETX
    controller.handleKey('', {}); // empty input (arrow-like)
    assert.equal(controller.state().field?.draft, '90');
    controller.handleKey('1', {});
    controller.handleKey('', { return: true });
    assert.deepEqual(await settled(port), { status: 'ok', value: '901' });
  });

  it('keeps the question open on a rejected answer and clears the error next', async () => {
    const controller = createWizardController();
    const validate = (value: string): string | undefined =>
      /^\d+$/.test(value) ? undefined : 'Enter an integer port between 1 and 65535.';
    const port = controller.ask({ kind: 'text', message: 'Port:', validate });
    controller.handleKey('nope', {});
    controller.handleKey('', { return: true });
    assert.match(controller.state().field?.error ?? '', /integer port/);
    controller.handleKey('1', {});
    assert.equal(controller.state().field?.error, undefined);
    controller.handleKey('', { return: true });
    // The draft survived the rejection, so the fix is one keystroke, not a
    // retype — 'nope1' still fails, so clear it first.
    assert.equal(controller.state().field?.draft, 'nope1');
    for (let i = 0; i < 'nope1'.length; i += 1) {
      controller.handleKey('', { backspace: true });
    }
    controller.handleKey('9001', {});
    controller.handleKey('', { return: true });
    assert.deepEqual(await settled(port), { status: 'ok', value: '9001' });
  });

  it('cancels on Ctrl-C and makes the quit sticky for later questions', async () => {
    const controller = createWizardController();
    const answer = controller.ask(multiselectRequest());
    controller.handleKey('c', { ctrl: true });
    assert.deepEqual(await settled(answer), { status: 'cancelled' });
    assert.equal(controller.quitting(), true);
    assert.equal(
      controller.state().field,
      null,
      'the live question is gone, not left hanging'
    );
    // The keystroke a human presses a beat early must not be swallowed by the
    // next question: it answers cancelled immediately, without a render.
    const next = await settled(controller.ask({ kind: 'confirm', message: 'Ship it?' }));
    assert.deepEqual(next, { status: 'cancelled' });
    assert.equal(
      controller.state().field,
      null,
      'a cancelled question never opens'
    );
  });

  it('cancels on Escape and records the cancelled recap', async () => {
    const controller = createWizardController();
    const answer = controller.ask({ kind: 'confirm', message: 'Ship it?' });
    controller.handleKey('', { escape: true });
    assert.deepEqual(await settled(answer), { status: 'cancelled' });
    assert.deepEqual(
      controller.state().lines.map((line) => [line.tone, line.text]),
      [['recap', 'Ship it? cancelled']]
    );
  });

  it('records notes and the walk-away line as durable lines', () => {
    const controller = createWizardController();
    controller.note('Launch skipped: needs a single platform.');
    controller.cancelLine('Session cancelled.');
    assert.deepEqual(
      controller.state().lines.map((line) => [line.tone, line.text]),
      [
        ['note', 'Launch skipped: needs a single platform.'],
        ['cancel', 'Session cancelled.'],
      ]
    );
    assert.deepEqual(
      controller.state().lines.map((line) => line.id),
      [1, 2],
      'ids are stable so the view keys on them'
    );
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const controller = createWizardController();
    let calls = 0;
    const unsubscribe = controller.subscribe(() => (calls += 1));
    void controller.ask(multiselectRequest());
    assert.equal(calls, 1, 'opening a question repaints');
    controller.handleKey(' ', {});
    assert.equal(calls, 2);
    unsubscribe();
    controller.handleKey(' ', {});
    assert.equal(calls, 2, 'a torn-down view must stop hearing the machine');
  });

  it('ignores keystrokes while no question is live', () => {
    const controller = createWizardController();
    assert.doesNotThrow(() => {
      controller.handleKey('', { return: true });
      controller.handleKey('j', {});
      controller.handleKey('typed', {});
    });
    assert.equal(controller.state().field, null);
    assert.deepEqual(controller.state().lines, []);
  });
});

// The purity promise the seam fence relies on (same check dev-tui-seam.test.ts
// runs against model.ts and banner.ts): this module may never grow an ink/react
// or io import, or the machine stops being testable without a terminal.
describe('wizard model: purity fence', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src', 'cli', 'dev-tui', 'wizard-model.ts'),
    'utf8'
  );

  it('has no ink/react import, static or dynamic', () => {
    assert.doesNotMatch(source, /^\s*import\b[^;]*?from\s+'(ink|react)'/m);
    assert.doesNotMatch(source, /\bimport\('(ink|react)'\)/);
  });

  it('holds `import type` statements only', () => {
    assert.deepEqual(
      [...source.matchAll(/^import\s+(?!type\s)[^;]*;/gm)].map(
        (match) => match[0]
      ),
      [],
      'wizard-model.ts may hold `import type` statements only'
    );
  });
});
