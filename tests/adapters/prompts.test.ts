// PromptPort adapters: readline over piped stdin, clack narrowed through a
// fake, and the clack -> readline fallback of `createPrompts`.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  createClackPrompts,
  createPrompts,
  createReadlinePrompts,
  type ClackLike,
} from '../../src/adapters/index.js';

function piped(input: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = '';
  stdout.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  stdin.end(input);
  return { stdin, stdout, output: () => written };
}

describe('readline prompts (piped stdin)', () => {
  it('answers every question type from one chunk of buffered lines', async () => {
    const io = piped('alpha, beta\nandroid\ny\n\n9100\nn\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'beta' },
    ];
    assert.deepEqual(
      await prompts.multiselect({ message: 'Remotes?', options, initialValues: ['alpha'] }),
      { status: 'ok', value: ['alpha', 'beta'] }
    );
    assert.deepEqual(
      await prompts.select({
        message: 'Platform?',
        options: [
          { value: 'ios', label: 'iOS' },
          { value: 'android', label: 'Android' },
        ],
      }),
      { status: 'ok', value: 'android' }
    );
    assert.deepEqual(await prompts.confirm({ message: 'Launch?' }), {
      status: 'ok',
      value: true,
    });
    // Empty answers take the default; a validated text re-asks until valid.
    assert.deepEqual(
      await prompts.confirm({ message: 'Standalone?', initialValue: false }),
      { status: 'ok', value: false }
    );
    assert.deepEqual(
      await prompts.text({
        message: 'Port?',
        validate: (value) => (/^\d+$/.test(value) ? undefined : 'digits only'),
      }),
      { status: 'ok', value: '9100' }
    );
    assert.deepEqual(await prompts.confirm({ message: 'Again?' }), {
      status: 'ok',
      value: false,
    });
    prompts.close();
  });

  it('re-asks after an invalid answer and reports why', async () => {
    const io = piped('nope\n70000\n8080\nmaybe\nyes\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const port = await prompts.text({
      message: 'Port?',
      validate: (value) =>
        Number(value) >= 1 && Number(value) <= 65_535 ? undefined : 'bad port',
    });
    assert.deepEqual(port, { status: 'ok', value: '8080' });
    assert.deepEqual(await prompts.confirm({ message: 'Go?' }), {
      status: 'ok',
      value: true,
    });
    assert.equal(io.output().match(/bad port/g)?.length, 2);
    assert.match(io.output(), /Answer y or n/);
    prompts.close();
  });

  it('rejects an empty multiselect and re-asks until something is picked', async () => {
    const io = piped('\n,\nbeta\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'beta' },
    ];
    assert.deepEqual(await prompts.multiselect({ message: 'Remotes?', options }), {
      status: 'ok',
      value: ['beta'],
    });
    assert.equal(io.output().match(/Select at least one option/g)?.length, 2);
    prompts.close();
  });

  it('lets `none` select nothing when emptyHint is set, in any case', async () => {
    const io = piped('none\nNONE\n  none \n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'beta' },
    ];
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(
        await prompts.multiselect({
          message: 'Which remotes to run?',
          options,
          initialValues: ['alpha', 'beta'],
          emptyHint: 'host only',
        }),
        { status: 'ok', value: [] }
      );
    }
    assert.match(
      io.output(),
      /Which remotes to run\? \(comma-separated, empty = alpha, beta; none = host only; options: alpha, beta\): /
    );
    prompts.close();
  });

  it('keeps an empty line on the preselection when emptyHint is set', async () => {
    const io = piped('\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [{ value: 'alpha', label: 'alpha' }];
    assert.deepEqual(
      await prompts.multiselect({
        message: 'Remotes?',
        options,
        initialValues: ['alpha'],
        emptyHint: 'host only',
      }),
      { status: 'ok', value: ['alpha'] }
    );
    prompts.close();
  });

  it('an option with the value none wins over the keyword and is not advertised', async () => {
    const io = piped('none\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [
      { value: 'none', label: 'none' },
      { value: 'alpha', label: 'alpha' },
    ];
    assert.deepEqual(
      await prompts.multiselect({ message: 'Remotes?', options, emptyHint: 'host only' }),
      { status: 'ok', value: ['none'] }
    );
    assert.doesNotMatch(io.output(), /none = /);
    prompts.close();
  });

  it('an option merely labelled None does not suppress the keyword', async () => {
    const io = piped('none\nx\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [
      { value: 'x', label: 'None' },
      { value: 'alpha', label: 'alpha' },
    ];
    const question = { message: 'Remotes?', options, emptyHint: 'host only' };
    assert.deepEqual(await prompts.multiselect(question), {
      status: 'ok',
      value: [],
    });
    assert.match(io.output(), /none = host only/);
    // The labelled option stays reachable by its value.
    assert.deepEqual(await prompts.multiselect(question), {
      status: 'ok',
      value: ['x'],
    });
    prompts.close();
  });

  it('without emptyHint, none is an unknown option and the prompt re-asks', async () => {
    const io = piped('none\n\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [{ value: 'alpha', label: 'alpha' }];
    assert.deepEqual(await prompts.multiselect({ message: 'Remotes?', options }), {
      status: 'cancelled',
    });
    assert.match(io.output(), /Unknown option; choose from: alpha/);
    assert.match(io.output(), /Select at least one option/);
    assert.doesNotMatch(io.output(), /none = /);
    prompts.close();
  });

  it('treats EOF as a cancel, before and between questions', async () => {
    const io = piped('y\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    assert.deepEqual(await prompts.confirm({ message: 'First?' }), {
      status: 'ok',
      value: true,
    });
    assert.deepEqual(await prompts.confirm({ message: 'Second?' }), {
      status: 'cancelled',
    });
    assert.deepEqual(await prompts.text({ message: 'Third?' }), {
      status: 'cancelled',
    });
    prompts.close();
  });

  it('a re-ask loop ends at EOF as a cancel instead of spinning', async () => {
    // An empty multiselect with no preselection re-asks; the closed stdin
    // must turn the next read into a cancel, not another empty answer.
    const io = piped('\n');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    const options = [{ value: 'alpha', label: 'alpha' }];
    assert.deepEqual(await prompts.multiselect({ message: 'Remotes?', options }), {
      status: 'cancelled',
    });
    assert.equal(io.output().match(/Select at least one option/g)?.length, 1);
    // Same for an invalid select answer followed by EOF.
    const bad = piped('nope\n');
    const second = createReadlinePrompts({ input: bad.stdin, output: bad.stdout });
    assert.deepEqual(await second.select({ message: 'Pick?', options }), {
      status: 'cancelled',
    });
    prompts.close();
    second.close();
  });

  it('prints notes and cancel announcements', () => {
    const io = piped('');
    const prompts = createReadlinePrompts({ input: io.stdin, output: io.stdout });
    prompts.note('Launch skipped.');
    prompts.cancel('Session cancelled.');
    assert.equal(io.output(), 'Launch skipped.\nSession cancelled.\n');
    prompts.close();
  });
});

function fakeClack(answers: unknown[]): ClackLike & { calls: string[] } {
  const CANCEL = Symbol('clack-cancel');
  const calls: string[] = [];
  const next = (label: string) => async () => {
    calls.push(label);
    const answer = answers.shift();
    return answer === 'CANCEL' ? CANCEL : answer;
  };
  return {
    calls,
    multiselect: next('multiselect'),
    select: next('select'),
    confirm: next('confirm'),
    text: next('text'),
    cancel: (message) => void calls.push(`cancel:${message}`),
    isCancel: (value) => value === CANCEL,
    log: { info: (message) => void calls.push(`info:${message}`) },
  };
}

describe('clack prompts', () => {
  it('maps answers and the cancel symbol to typed results', async () => {
    const clack = fakeClack([['a'], 'ios', false, '90', 'CANCEL']);
    const prompts = createClackPrompts(clack);
    const options = [{ value: 'a', label: 'a' }];
    assert.deepEqual(await prompts.multiselect({ message: 'm', options }), {
      status: 'ok',
      value: ['a'],
    });
    assert.deepEqual(await prompts.select({ message: 's', options }), {
      status: 'ok',
      value: 'ios',
    });
    assert.deepEqual(await prompts.confirm({ message: 'c' }), {
      status: 'ok',
      value: false,
    });
    assert.deepEqual(await prompts.text({ message: 't' }), {
      status: 'ok',
      value: '90',
    });
    assert.deepEqual(await prompts.confirm({ message: 'c2' }), {
      status: 'cancelled',
    });
    prompts.note('hello');
    prompts.cancel('bye');
    assert.deepEqual(clack.calls.slice(-2), ['info:hello', 'cancel:bye']);
  });
});

describe('clack required flag', () => {
  it('follows emptyHint: required without it, optional with it', async () => {
    const seen: Array<boolean | undefined> = [];
    const clack = fakeClack([['a'], []]);
    const original = clack.multiselect;
    clack.multiselect = (options) => {
      seen.push(options.required);
      return original(options);
    };
    const prompts = createClackPrompts(clack);
    const options = [{ value: 'a', label: 'a' }];
    await prompts.multiselect({ message: 'm', options });
    assert.deepEqual(
      await prompts.multiselect({ message: 'm', options, emptyHint: 'host only' }),
      { status: 'ok', value: [] }
    );
    assert.deepEqual(seen, [true, false]);
  });
});

describe('createPrompts', () => {
  it('uses clack when it loads', async () => {
    const clack = fakeClack([true]);
    const prompts = await createPrompts({ loadClack: async () => clack });
    assert.deepEqual(await prompts.confirm({ message: 'ok?' }), {
      status: 'ok',
      value: true,
    });
    assert.deepEqual(clack.calls, ['confirm']);
  });

  it('falls back to readline when the clack import fails', async () => {
    const io = piped('y\n');
    const prompts = await createPrompts({
      loadClack: async () => {
        throw new Error('Cannot find package @clack/prompts');
      },
      input: io.stdin,
      output: io.stdout,
    });
    assert.deepEqual(await prompts.confirm({ message: 'ok?' }), {
      status: 'ok',
      value: true,
    });
    assert.match(io.output(), /ok\? \(Y\/n\): /);
    prompts.close();
  });
});
