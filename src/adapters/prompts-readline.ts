// `PromptPort` over plain `node:readline`: the fallback when `@clack/prompts`
// cannot be loaded. Sequential line prompts that also work with piped input.
// EOF (stdin closed mid-question) is a cancel, like Ctrl-C in clack.

import nodeReadline from 'node:readline';
import type {
  PromptOption,
  PromptPort,
  PromptResult,
} from '../core/index.js';

export interface ReadlinePromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const CLOSED = new Error('input closed while a prompt was pending');

/**
 * Line reader that BUFFERS lines arriving while no question is pending:
 * `readline`'s own `question()` drops them, which hangs the next question on
 * piped input (every answer arrives in one chunk). After EOF the buffered
 * lines still answer, then every further question rejects.
 */
function createLineReader(
  stream: NodeJS.ReadableStream,
  out: NodeJS.WritableStream
) {
  const rl = nodeReadline.createInterface({
    input: stream as NodeJS.ReadStream,
    output: out as NodeJS.WriteStream,
    terminal: Boolean((stream as { isTTY?: boolean }).isTTY),
  });
  const buffered: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let ended = false;
  rl.on('line', (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on('close', () => {
    ended = true;
    waiter?.(null);
    waiter = null;
  });
  return {
    async question(prompt: string): Promise<string> {
      out.write(prompt);
      if (buffered.length > 0) return buffered.shift() as string;
      if (ended) throw CLOSED;
      const line = await new Promise<string | null>((resolve) => {
        waiter = resolve;
      });
      if (line === null) throw CLOSED;
      return line;
    },
    close() {
      rl.close();
    },
  };
}

/** Readline answer for "nothing" when a multiselect has an `emptyHint`. */
const NONE_KEYWORD = 'none';

const matchOption = (
  options: PromptOption[],
  answer: string
): PromptOption | undefined => {
  const wanted = answer.trim().toLowerCase();
  return options.find(
    (option) =>
      option.value.toLowerCase() === wanted ||
      option.label.toLowerCase() === wanted
  );
};

export function createReadlinePrompts(
  streams: ReadlinePromptStreams = {}
): PromptPort {
  const out = streams.output ?? process.stdout;
  const reader = createLineReader(streams.input ?? process.stdin, out);

  // A rejected question (EOF) is the user leaving: report it as a cancel.
  const guard = async <T>(
    run: () => Promise<PromptResult<T>>
  ): Promise<PromptResult<T>> => {
    try {
      return await run();
    } catch {
      return { status: 'cancelled' };
    }
  };

  return {
    multiselect: (question) =>
      guard(async () => {
        const initial = question.initialValues ?? [];
        const names = question.options.map((option) => option.value).join(', ');
        // `none` selects nothing, unless an option is literally named `none`:
        // then the option wins and the keyword is not offered.
        const noneHint =
          question.emptyHint !== undefined &&
          matchOption(question.options, NONE_KEYWORD) === undefined
            ? question.emptyHint
            : undefined;
        for (;;) {
          const answer = (
            await reader.question(
              `${question.message} (comma-separated, ${initial.length > 0 ? `empty = ${initial.join(', ')}; ` : ''}${noneHint !== undefined ? `${NONE_KEYWORD} = ${noneHint}; ` : ''}options: ${names}): `
            )
          ).trim();
          if (noneHint !== undefined && answer.toLowerCase() === NONE_KEYWORD) {
            return { status: 'ok', value: [] };
          }
          if (answer === '') {
            // An empty line takes the preselection; with none to take, re-ask.
            if (initial.length > 0) return { status: 'ok', value: initial };
            out.write(`Select at least one option: ${names}\n`);
            continue;
          }
          const picked = answer
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== '')
            .map((name) => matchOption(question.options, name));
          if (picked.length === 0) {
            out.write(`Select at least one option: ${names}\n`);
            continue;
          }
          if (picked.every((option) => option !== undefined)) {
            const values = picked.map((option) => option!.value);
            return { status: 'ok', value: [...new Set(values)] };
          }
          out.write(`Unknown option; choose from: ${names}\n`);
        }
      }),
    select: (question) =>
      guard(async () => {
        const names = question.options.map((option) => option.value).join('/');
        const hint =
          question.initialValue !== undefined
            ? `${names}, empty = ${question.initialValue}`
            : names;
        for (;;) {
          const answer = (
            await reader.question(`${question.message} (${hint}): `)
          ).trim();
          if (answer === '' && question.initialValue !== undefined) {
            return { status: 'ok', value: question.initialValue };
          }
          const option = matchOption(question.options, answer);
          if (option !== undefined) {
            return { status: 'ok', value: option.value };
          }
          out.write(`Unknown option; choose one of: ${names}\n`);
        }
      }),
    confirm: (question) =>
      guard(async () => {
        const fallback = question.initialValue ?? true;
        for (;;) {
          const answer = (
            await reader.question(
              `${question.message} (${fallback ? 'Y/n' : 'y/N'}): `
            )
          )
            .trim()
            .toLowerCase();
          if (answer === '') return { status: 'ok', value: fallback };
          if (answer === 'y' || answer === 'yes') {
            return { status: 'ok', value: true };
          }
          if (answer === 'n' || answer === 'no') {
            return { status: 'ok', value: false };
          }
          out.write('Answer y or n.\n');
        }
      }),
    text: (question) =>
      guard(async () => {
        for (;;) {
          const answer = (
            await reader.question(`${question.message} `)
          ).trim();
          const problem = question.validate?.(answer);
          if (problem === undefined) return { status: 'ok', value: answer };
          out.write(`${problem}\n`);
        }
      }),
    note: (message) => {
      out.write(`${message}\n`);
    },
    cancel: (message) => {
      out.write(`${message}\n`);
    },
    close: () => reader.close(),
  };
}
