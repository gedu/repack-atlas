// Hand-rolled argv parsing for the `repack-atlas` bin (no new dependency,
// AGENTS.md rule 11: the CLI is a thin adapter). One
// small spec-driven parser is shared by every subcommand so unknown options,
// missing values and repeatable options behave identically everywhere —
// every parse failure maps to exit code 2 ("could not answer").

/** Which options a subcommand accepts, by value shape. */
export interface ArgSpec {
  /** Options that require a value (`--host <ref>`). */
  valueOptions: string[];
  /** Options whose value is optional (`--workspace [dir]`). */
  optionalValueOptions: string[];
  /** Value-less switches (`--json`). */
  booleanFlags: string[];
}

export interface ParsedArgs {
  /** Explicit values per option, in argv order (repeatable options keep all). */
  values: Map<string, string[]>;
  /** Every option name seen, with or without a value. */
  options: Set<string>;
  /** Boolean flags seen. */
  flags: Set<string>;
  /** Non-option arguments, in order. */
  positional: string[];
  /** Parse failure reason; the CLI renders it and exits 2. */
  error?: string;
}

function isFlagLike(token: string): boolean {
  return token.startsWith('--') && token.length > 2;
}

function fail(error: string): ParsedArgs {
  return {
    values: new Map(),
    options: new Set(),
    flags: new Set(),
    positional: [],
    error,
  };
}

/**
 * Parse `argv` (already stripped of the command name) against `spec`.
 * Supports `--opt value`, `--opt=value`, repeatable options, optional-value
 * options (`--workspace` alone means "present, default dir") and boolean
 * flags. Anything else — unknown options, values attached to boolean flags,
 * missing required values — is a parse error, never a guess.
 */
export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const valueOptions = new Set(spec.valueOptions);
  const optionalValueOptions = new Set(spec.optionalValueOptions);
  const booleanFlags = new Set(spec.booleanFlags);
  const result: ParsedArgs = {
    values: new Map(),
    options: new Set(),
    flags: new Set(),
    positional: [],
  };

  const pushValue = (name: string, value: string): void => {
    const list = result.values.get(name);
    if (list) list.push(value);
    else result.values.set(name, [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!isFlagLike(token)) {
      result.positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    if (booleanFlags.has(name)) {
      if (inlineValue !== undefined) {
        return fail(`--${name} does not take a value`);
      }
      result.flags.add(name);
      continue;
    }

    if (valueOptions.has(name) || optionalValueOptions.has(name)) {
      result.options.add(name);
      if (inlineValue !== undefined) {
        if (inlineValue === '') return fail(`--${name} requires a value`);
        pushValue(name, inlineValue);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !isFlagLike(next) && next !== '') {
        pushValue(name, next);
        i += 1;
        continue;
      }
      if (valueOptions.has(name)) {
        return fail(`--${name} requires a value`);
      }
      continue; // optional-value option seen without a value: presence only
    }

    return fail(`unknown option --${name}`);
  }

  return result;
}

/** Last explicit value of an option, `undefined` when only presence was seen. */
export function lastValue(parsed: ParsedArgs, name: string): string | undefined {
  const list = parsed.values.get(name);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}
