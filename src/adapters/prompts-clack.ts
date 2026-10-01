// `PromptPort` over `@clack/prompts` (Atlas's one runtime dependency, loaded
// by dynamic import so a missing or broken install degrades to the readline
// adapter instead of breaking `dev`). The library surface is narrowed to
// `ClackLike`, which keeps tests free of a real terminal.

import type { PromptPort, PromptResult } from '../core/index.js';

/** The slice of `@clack/prompts` the adapter uses. */
export interface ClackLike {
  multiselect(options: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValues?: string[];
    required?: boolean;
    maxItems?: number;
  }): Promise<unknown>;
  select(options: {
    message: string;
    options: Array<{ value: string; label: string }>;
    initialValue?: string;
  }): Promise<unknown>;
  confirm(options: {
    message: string;
    initialValue?: boolean;
  }): Promise<unknown>;
  text(options: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<unknown>;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
  log: { info(message: string): void };
}

export type ClackLoader = () => Promise<ClackLike>;

export const loadClack: ClackLoader = async () =>
  (await import('@clack/prompts')) as unknown as ClackLike;

export function createClackPrompts(clack: ClackLike): PromptPort {
  const ask = async <T>(
    run: () => Promise<unknown>
  ): Promise<PromptResult<T>> => {
    const answer = await run();
    return clack.isCancel(answer)
      ? { status: 'cancelled' }
      : { status: 'ok', value: answer as T };
  };
  return {
    multiselect: (question) =>
      ask<string[]>(() =>
        clack.multiselect({
          message: question.message,
          options: question.options,
          ...(question.initialValues !== undefined
            ? { initialValues: question.initialValues }
            : {}),
          required: false,
          maxItems: 8,
        })
      ),
    select: (question) =>
      ask<string>(() =>
        clack.select({
          message: question.message,
          options: question.options,
          ...(question.initialValue !== undefined
            ? { initialValue: question.initialValue }
            : {}),
        })
      ),
    confirm: (question) =>
      ask<boolean>(() =>
        clack.confirm({
          message: question.message,
          ...(question.initialValue !== undefined
            ? { initialValue: question.initialValue }
            : {}),
        })
      ),
    text: (question) =>
      ask<string>(() =>
        clack.text({
          message: question.message,
          ...(question.validate !== undefined
            ? { validate: question.validate }
            : {}),
        })
      ),
    note: (message) => clack.log.info(message),
    cancel: (message) => clack.cancel(message),
    close() {
      // clack owns no stream between prompts.
    },
  };
}
