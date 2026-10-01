// Scripted `PromptPort` for wizard tests (not a test file itself): answers
// come from a queue, every question is recorded in order.

import type { PromptPort, PromptResult } from '../../src/core/index.js';

export const CANCEL = Symbol('cancel');

export type ScriptedAnswer = string | string[] | boolean | typeof CANCEL;

export interface FakePrompts extends PromptPort {
  /** `kind: message` per question, in the order asked. */
  asked: string[];
  /** Option values offered per `select`/`multiselect`, in the order asked. */
  offered: Array<{ message: string; values: string[] }>;
  /** `emptyHint` of every `multiselect`, in the order asked. */
  emptyHints: Array<string | undefined>;
  notes: string[];
  cancels: string[];
  closed: number;
  /** Validator results for every `text` answer (undefined = accepted). */
  validations: Array<string | undefined>;
  remaining(): number;
}

export function fakePrompts(script: ScriptedAnswer[]): FakePrompts {
  const queue = [...script];
  const fake: FakePrompts = {
    asked: [],
    offered: [],
    emptyHints: [],
    notes: [],
    cancels: [],
    closed: 0,
    validations: [],
    remaining: () => queue.length,
    multiselect: (q) => {
      fake.emptyHints.push(q.emptyHint);
      fake.offered.push({ message: q.message, values: q.options.map((o) => o.value) });
      return answer(`multiselect: ${q.message}`);
    },
    select: (q) => {
      fake.offered.push({ message: q.message, values: q.options.map((o) => o.value) });
      return answer(`select: ${q.message}`);
    },
    confirm: (q) => answer(`confirm: ${q.message}`),
    text: async (q) => {
      const result = await answer<string>(`text: ${q.message}`);
      if (result.status === 'ok') fake.validations.push(q.validate?.(result.value));
      return result;
    },
    note: (message) => void fake.notes.push(message),
    cancel: (message) => void fake.cancels.push(message),
    close: () => void (fake.closed += 1),
  };

  async function answer<T>(label: string): Promise<PromptResult<T>> {
    fake.asked.push(label);
    if (queue.length === 0) throw new Error(`unscripted question: ${label}`);
    const next = queue.shift()!;
    return next === CANCEL
      ? { status: 'cancelled' }
      : { status: 'ok', value: next as T };
  }
  return fake;
}
