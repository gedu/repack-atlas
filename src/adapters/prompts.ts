// `createPrompts()`: the one place that decides which `PromptPort` answers.
// `@clack/prompts` first (wizard UX parity with Re.Pack's federation dev
// runner); readline when the import fails, so `dev` never breaks on it.

import type { PromptPort } from '../core/index.js';
import {
  createClackPrompts,
  loadClack,
  type ClackLoader,
} from './prompts-clack.js';
import {
  createReadlinePrompts,
  type ReadlinePromptStreams,
} from './prompts-readline.js';

export interface CreatePromptsOptions extends ReadlinePromptStreams {
  /** Test seam: replaces the dynamic `import('@clack/prompts')`. */
  loadClack?: ClackLoader;
}

export async function createPrompts(
  options: CreatePromptsOptions = {}
): Promise<PromptPort> {
  try {
    return createClackPrompts(await (options.loadClack ?? loadClack)());
  } catch {
    return createReadlinePrompts(options);
  }
}
