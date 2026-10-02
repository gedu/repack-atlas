// Pure state machine behind the ink wizard prompts (G5, "wizard-in-TUI").
// Mirror of `model.ts` purity (tests/cli/dev-tui-banner.test.ts pattern): NO
// io, NO ink, NO react, NO node builtins — the runtime imports below are
// `import type` only and are erased by tsc. Every transition is deterministic
// data-in / data-out, so `tests/cli/dev-tui-wizard.test.ts` asserts the whole
// interaction contract without a terminal; the ink layer (`wizard.tsx`) then
// only maps keystrokes to these calls and renders the state.
//
// One `WizardField` is one live question; the `WizardController` at the bottom
// owns it plus the durable recap/note lines and the promise the port returns.
// The wizard flow is sequential, so there is one cursor over one list — no
// routing table and no focus manager.
//
// Deliberate choices:
// - Navigation CLAMPS at the ends instead of wrapping (same rule as the
//   dashboard roster): predictable on a two-option list.
// - Multiselect answers are reported in OPTION order, never click order, so the
//   plan inputs a keyboard session produces match what the flags would produce.
// - `submit` never guesses: it returns the field with `error` set and the
//   caller keeps the question open. That is how the port shows a `validate`
//   message before accepting a port number.
// - A cancel is sticky (`quit()`): the keystroke a human presses a beat early
//   is not swallowed — the next question answers cancelled too.

import type { PromptOption, PromptResult } from '../../core/index.js';

/** The four question shapes `PromptPort` carries. */
export type PromptKind = 'multiselect' | 'select' | 'confirm' | 'text';

/** A question as the port received it, in the shape the machine opens. */
export type WizardRequest =
  | {
      kind: 'multiselect';
      message: string;
      options: readonly PromptOption[];
      initialValues?: string[];
      emptyHint?: string;
    }
  | {
      kind: 'select';
      message: string;
      options: readonly PromptOption[];
      initialValue?: string;
    }
  | { kind: 'confirm'; message: string; initialValue?: boolean }
  | {
      kind: 'text';
      message: string;
      validate?(value: string): string | undefined;
    };

/** The answer value space of the four kinds. */
export type WizardValue = string[] | string | boolean;

/**
 * One live question. Optional slots are `| undefined` (never absent) so
 * transitions can spread a field without `exactOptionalPropertyTypes` games.
 */
export interface WizardField {
  kind: PromptKind;
  message: string;
  options: readonly PromptOption[];
  /** When set, an empty multiselect is a valid answer meaning this. */
  emptyHint: string | undefined;
  /** Validator of a `text` question: error message or `undefined` when fine. */
  validate: ((value: string) => string | undefined) | undefined;
  /** Focused option index (multiselect/select); 0 for the other kinds. */
  cursor: number;
  /** Ticked values (multiselect), kept in the order the options were asked. */
  selected: readonly string[];
  /** Draft of a `text` question. */
  draft: string;
  /** Current answer of a `confirm`. */
  confirmed: boolean;
  /** Last rejection, shown while the question stays open. */
  error: string | undefined;
}

/** `submit` outcome: an answer, or the same question with a reason. */
export type WizardSubmit =
  | { status: 'ok'; value: WizardValue }
  | { status: 'invalid'; field: WizardField };

/** Shown when a multiselect is submitted empty and no `emptyHint` allows it. */
export const EMPTY_SELECTION_ERROR = 'Select at least one option.';

/** Index of `value` in `options`, or -1. */
function indexOfValue(
  options: readonly PromptOption[],
  value: string | undefined
): number {
  if (value === undefined) return -1;
  return options.findIndex((option) => option.value === value);
}

/** Open a question: focus/selection/draft start from its initial values. */
export function openField(request: WizardRequest): WizardField {
  const blank: WizardField = {
    kind: request.kind,
    message: request.message,
    options: [],
    emptyHint: undefined,
    validate: undefined,
    cursor: 0,
    selected: [],
    draft: '',
    confirmed: true,
    error: undefined,
  };
  switch (request.kind) {
    case 'multiselect': {
      // Only values the question actually offered: an unknown initial would
      // otherwise invent an option the view can never un-tick.
      const initial = request.initialValues ?? [];
      return {
        ...blank,
        options: request.options,
        emptyHint: request.emptyHint,
        selected: request.options
          .filter((option) => initial.includes(option.value))
          .map((option) => option.value),
      };
    }
    case 'select': {
      const wanted = indexOfValue(request.options, request.initialValue);
      return {
        ...blank,
        options: request.options,
        cursor: wanted >= 0 ? wanted : 0,
      };
    }
    case 'confirm':
      // The answer is a boolean, not an option row: the view draws the y/n
      // pair itself, so `options` stays empty and the cursor is meaningless.
      return { ...blank, confirmed: request.initialValue ?? true };
    case 'text':
      return { ...blank, validate: request.validate };
  }
}

/** Move the focus, clamped: the ends stay put (no wrap). */
export function moveCursor(field: WizardField, delta: number): WizardField {
  if (field.options.length === 0) return field;
  const next = Math.min(
    field.options.length - 1,
    Math.max(0, field.cursor + delta)
  );
  return next === field.cursor ? field : { ...field, cursor: next };
}

/** Tick/untick the focused option (multiselect only; others are unchanged). */
export function toggleFocused(field: WizardField): WizardField {
  if (field.kind !== 'multiselect') return field;
  const option = field.options[field.cursor];
  if (option === undefined) return field;
  const has = field.selected.includes(option.value);
  const selected = has
    ? field.selected.filter((value) => value !== option.value)
    : field.options
        .filter(
          (candidate) =>
            candidate.value === option.value ||
            field.selected.includes(candidate.value)
        )
        .map((candidate) => candidate.value);
  return { ...field, selected };
}

/** Replace the draft (a paste arrives whole). Typing clears a stale error. */
export function setDraft(field: WizardField, draft: string): WizardField {
  return { ...field, draft, error: undefined };
}

/** Backspace/Delete on the draft. */
export function backspaceDraft(field: WizardField): WizardField {
  return setDraft(field, field.draft.slice(0, -1));
}

/** Flip or set the confirm answer. */
export function setConfirmed(
  field: WizardField,
  confirmed: boolean | 'flip' = 'flip'
): WizardField {
  const next = confirmed === 'flip' ? !field.confirmed : confirmed;
  return { ...field, confirmed: next };
}

/** Selection in option order (never click order). */
export function selectionValues(field: WizardField): string[] {
  return field.options
    .filter((option) => field.selected.includes(option.value))
    .map((option) => option.value);
}

/**
 * Try to accept the question. `text` runs the caller's `validate` and, when it
 * answers with a message, keeps the question open showing that message; an
 * empty multiselect is valid only with an `emptyHint`.
 */
export function submitField(field: WizardField): WizardSubmit {
  if (field.kind === 'multiselect') {
    const value = selectionValues(field);
    if (value.length === 0 && field.emptyHint === undefined) {
      return { status: 'invalid', field: { ...field, error: EMPTY_SELECTION_ERROR } };
    }
    return { status: 'ok', value };
  }
  if (field.kind === 'select') {
    const option = field.options[field.cursor];
    if (option === undefined) {
      return { status: 'invalid', field: { ...field, error: 'No option to choose.' } };
    }
    return { status: 'ok', value: option.value };
  }
  if (field.kind === 'confirm') {
    return { status: 'ok', value: field.confirmed };
  }
  const value = field.draft.trim();
  const problem = field.validate?.(value);
  if (problem !== undefined) {
    return { status: 'invalid', field: { ...field, error: problem } };
  }
  return { status: 'ok', value };
}

/** The answer as one plain word/phrase, for the settled recap line. */
export function answerText(field: WizardField, value: WizardValue): string {
  if (field.kind === 'confirm') return value === true ? 'yes' : 'no';
  if (field.kind === 'select') {
    const option = field.options.find((candidate) => candidate.value === value);
    return option?.label ?? String(value);
  }
  if (field.kind === 'multiselect') {
    const values = Array.isArray(value) ? value : [];
    if (values.length === 0) return field.emptyHint ?? 'none';
    return values
      .map(
        (selected) =>
          field.options.find((option) => option.value === selected)?.label ??
          selected
      )
      .join(', ');
  }
  return String(value);
}

/** Settled recap line the view keeps on screen (dim, in `<Static>`). */
export function recapText(
  field: WizardField,
  result: { status: 'ok'; value: WizardValue } | { status: 'cancelled' }
): string {
  if (result.status === 'cancelled') return `${field.message} cancelled`;
  return `${field.message} ${answerText(field, result.value)}`;
}

/** One-line key help per kind (rendered under the question). */
export function helpText(field: WizardField): string {
  const empty =
    field.emptyHint === undefined
      ? ''
      : ` · clear all for ${field.emptyHint}`;
  switch (field.kind) {
    case 'multiselect':
      return `↑↓ move · space toggle · enter confirm${empty}`;
    case 'select':
      return '↑↓ move · enter confirm';
    case 'confirm':
      return 'y/n · space toggle · enter confirm';
    case 'text':
      return 'type the value · enter confirm';
  }
}

// ---------------------------------------------------------------------------
// Controller: the state the ink view renders and the port drives
// ---------------------------------------------------------------------------

/**
 * The keystroke shape the controller reads — the slice of ink's `useInput`
 * key object the wizard looks at, declared here so the machine (and its
 * tests) never needs ink's types.
 */
export interface WizardKeyInput {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

/** A durable line: a settled recap, a note, or the walk-away line. */
export interface WizardLine {
  id: number;
  text: string;
  tone: 'recap' | 'note' | 'cancel';
}

export interface WizardState {
  lines: readonly WizardLine[];
  /** The live question, or `null` between questions. */
  field: WizardField | null;
}

/**
 * Owns the live question, the durable lines, and the promise the port returns.
 * It lives OUTSIDE React on purpose: the answer is a promise the flow awaits,
 * so React only mirrors this state and can never disagree with it. The ink
 * component subscribes; every transition is a pure function above.
 */
export interface WizardController {
  state(): WizardState;
  subscribe(listener: () => void): () => void;
  /** Open a question; resolves with the answer, or a cancel. */
  ask(request: WizardRequest): Promise<PromptResult<WizardValue>>;
  /** Cancel the live question and remember the quit for the next one. */
  quit(): void;
  note(text: string): void;
  cancelLine(text: string): void;
  /** Route one keystroke (also the seam the tests use). */
  handleKey(input: string, key: WizardKeyInput): void;
  /** True once the user has cancelled. */
  quitting(): boolean;
}

interface PendingQuestion {
  field: WizardField;
  resolve(result: PromptResult<WizardValue>): void;
}

const EMPTY_STATE: WizardState = { lines: [], field: null };

export function createWizardController(): WizardController {
  let state: WizardState = EMPTY_STATE;
  let pending: PendingQuestion | null = null;
  let quitRequested = false;
  let nextId = 1;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const push = (text: string, tone: WizardLine['tone']): void => {
    state = { ...state, lines: [...state.lines, { id: nextId++, text, tone }] };
  };
  /** Replace the live field (keeping the pending mirror the recap reads). */
  const patch = (field: WizardField): void => {
    state = { ...state, field };
    if (pending !== null) pending = { ...pending, field };
    emit();
  };
  /** Settle the live question: recap line, then resolve the waiting caller. */
  const settle = (result: PromptResult<WizardValue>): void => {
    const current = pending;
    pending = null;
    state = { ...state, field: null };
    if (current !== null) push(recapText(current.field, result), 'recap');
    emit();
    current?.resolve(result);
  };

  const controller: WizardController = {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ask(request) {
      // A Ctrl-C pressed while nothing was asked still means "I'm out", and
      // must not hang: the next question answers cancelled instead.
      if (quitRequested) return Promise.resolve({ status: 'cancelled' });
      // One live question at a time: `pending` is a single slot, so a second
      // concurrent ask would orphan the first promise forever. The port is
      // sequential-by-construction today (the wizard awaits each answer), so
      // this guard only answers the caller bug — immediately cancelled, with
      // the live question untouched — instead of hanging both.
      if (pending !== null) return Promise.resolve({ status: 'cancelled' });
      return new Promise<PromptResult<WizardValue>>((resolve) => {
        const field = openField(request);
        pending = { field, resolve };
        state = { ...state, field };
        emit();
      });
    },
    quit() {
      quitRequested = true;
      settle({ status: 'cancelled' });
    },
    note(text) {
      push(text, 'note');
      emit();
    },
    cancelLine(text) {
      push(text, 'cancel');
      emit();
    },
    handleKey(input, key) {
      if (key.ctrl === true && input === 'c') return controller.quit();
      if (key.escape === true) return controller.quit();
      const field = state.field;
      if (field === null) return undefined;

      if (key.upArrow === true || input === 'k') {
        return patch(moveCursor(field, -1));
      }
      if (key.downArrow === true || input === 'j') {
        return patch(moveCursor(field, 1));
      }
      if (key.return === true) {
        const submit = submitField(field);
        if (submit.status === 'invalid') return patch(submit.field);
        return settle({ status: 'ok', value: submit.value });
      }
      if (field.kind === 'multiselect' && input === ' ') {
        return patch(toggleFocused(field));
      }
      if (field.kind === 'confirm') {
        if (input === 'y') return settle({ status: 'ok', value: true });
        if (input === 'n') return settle({ status: 'ok', value: false });
        if (input === ' ') return patch(setConfirmed(field));
        return undefined;
      }
      if (field.kind === 'text') {
        if (key.backspace === true || key.delete === true) {
          return patch(backspaceDraft(field));
        }
        // Printable only — a control byte encodes a keystroke, not text (the
        // same rule the dashboard's typed-input line applies).
        for (const char of input) {
          const code = char.codePointAt(0) ?? 0;
          if (code < 0x20 || code === 0x7f) return undefined;
        }
        if (input === '') return undefined;
        return patch(setDraft(field, `${field.draft}${input}`));
      }
      return undefined;
    },
    quitting: () => quitRequested,
  };
  return controller;
}
