/** @jsxImportSource react */
// Ink-rendered `PromptPort` for the interactive `dev` wizard (G5,
// "wizard-in-TUI"): the dashboard's visual language (pink 38;5;213 / Re.Pack
// green, dim help lines) answering the wizard's questions on the NORMAL
// screen. The alt screen belongs to the dashboard, which mounts later — the
// wizard must not take it, or the banner and the plan table would be wiped.
//
// Rule 11 exception (b): this file IS the ink/react render layer, so `dev.ts`
// dynamic-imports exactly this module and only when the TUI path is live;
// `--json`/`--ci`/non-TTY never load ink or react. The fence
// (tests/cli/dev-tui-seam.test.ts) locks dev.ts free of static ink/react
// imports. The interaction logic is NOT here: it is the pure machine in
// `wizard-model.ts`, asserted without a terminal; what lives here is the
// viewport, the keystroke routing, and one ink session's terminal hygiene.
//
// Terminal hygiene contract (dev.ts's "stdin must be clean before ink takes
// it" comment is why this matters):
// - ONE session for the whole wizard, mounted with the first question and
//   unmounted by `close()` (idempotent). ink hides the cursor while it renders
//   and shows it again on unmount; `close()` writes the show-cursor decseq
//   itself as well, so a hidden cursor can never outlive the wizard.
// - ink's `useInput` owns raw mode (it refs stdin and restores it on unmount);
//   `close()` additionally puts raw mode off and pauses stdin.
// - Ctrl-C and Esc cancel the live question; the quit is sticky in the
//   controller, so a keystroke pressed a beat early is not swallowed.
// - `note`/`cancel` go through the live session while mounted (one column,
//   recaps and notes in order) and straight to stdout when not.

import { Box, Text, render, renderToString, useInput } from 'ink';
import { useEffect, useLayoutEffect, useState } from 'react';
import type { Instance } from 'ink';
import type { PromptPort, PromptResult } from '../../core/index.js';
import {
  createWizardController,
  helpText,
  type WizardController,
  type WizardField,
  type WizardLine,
  type WizardRequest,
  type WizardState,
} from './wizard-model.js';
import { colorAllowed } from './banner.js';
import {
  isUsableSize,
  safestReflowCompensation,
  terminalReflowsOnResize,
} from './reflow.js';

// ---------------------------------------------------------------------------
// Visual language
// ---------------------------------------------------------------------------

/** The banner's pink, as an ink color token (app.tsx's `color={...}` idiom). */
export const PINK = 'ansi256(213)';

// Hand-rolled SGR subset for the lines written OUTSIDE ink (banner.ts is the
// precedent: rule 11 keeps a color library out, and one runtime-built ESC
// constant keeps the idiom uniform across the TUI code).
const ESC = String.fromCharCode(0x1b);
const SGR = {
  reset: '[0m',
  dim: '[2m',
  green: '[32m',
} as const;

function paint(codes: string, text: string): string {
  return `${ESC}${codes}${text}${ESC}${SGR.reset}`;
}

// Markers reuse the dashboard's glyph vocabulary rather than inventing one:
// `●` is the starting/bundling dot (model.ts STATUS_PRESENTATION) and `✓` the
// ready one, so "a question is live" and "a question is answered" read the
// same way in both screens. `▍` is the roster's selection bar, `›` the F12
// input caret (app.tsx). All three already render in the dashboard.
/** Live-question marker (pink). */
export const PROMPT_GLYPH = '●';
/** Settled-answer marker (green). */
export const DONE_GLYPH = '✓';
/** Focused-row marker. */
export const CURSOR_GLYPH = '▍';
/** Typed-input caret. */
export const INPUT_CARET = '› ';
/** Multiselect boxes: ascii, so no font support is assumed. */
export const CHECKED = '[x]';
export const UNCHECKED = '[ ]';
/** The two answers a confirm draws (the live one is bold + accent). */
export const CONFIRM_ANSWERS: readonly { label: string; value: boolean }[] = [
  { label: 'yes', value: true },
  { label: 'no', value: false },
];

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface WizardAppProps {
  controller: WizardController;
  /** false renders with zero escape bytes (the banner's color/no-color split). */
  color: boolean;
  /** Called with every state React commits (the frames ink may have drawn). */
  onCommit?: (state: WizardState) => void;
}

/**
 * One durable line above the live question. It truncates (`…`) rather than
 * wraps: rows a shrink pushes into scrollback cannot be erased, so the panel
 * keeps one row per answer at every width and never outgrows the screen.
 */
export function WizardLineView({
  line,
  color,
}: {
  line: WizardLine;
  color: boolean;
}) {
  if (line.tone === 'recap') {
    return (
      <Text
        wrap="truncate-end"
        {...(color ? { color: 'green' } : { dimColor: true })}
      >
        {`${DONE_GLYPH} ${line.text}`}
      </Text>
    );
  }
  if (line.tone === 'cancel') {
    return (
      <Text
        wrap="truncate-end"
        {...(color ? { color: 'green' } : { dimColor: true })}
      >
        {line.text}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end" dimColor>
      {line.text}
    </Text>
  );
}

/** The live question: message, options (or the typed draft), error, key help. */
export function WizardFieldView({
  field,
  color,
}: {
  field: WizardField;
  color: boolean;
}) {
  // `exactOptionalPropertyTypes` forbids a `color?: string | undefined`
  // spread, so the accent arrives as a whole props object or nothing.
  const accent = (on: boolean): { color: string } | Record<string, never> =>
    on && color ? { color: PINK } : {};
  return (
    <Box flexDirection="column">
      <Box>
        <Text {...accent(true)} bold>
          {PROMPT_GLYPH}
        </Text>
        <Text bold>{` ${field.message}`}</Text>
      </Box>
      {field.options.map((option, index) => {
        const focused = index === field.cursor;
        const box =
          field.kind === 'multiselect'
            ? field.selected.includes(option.value)
              ? CHECKED
              : UNCHECKED
            : undefined;
        return (
          <Box key={option.value}>
            <Text {...accent(focused)}>{focused ? CURSOR_GLYPH : ' '}</Text>
            {box === undefined ? null : <Text dimColor>{`${box} `}</Text>}
            <Text {...(focused ? { bold: true } : {})} {...accent(focused)}>
              {option.label}
            </Text>
          </Box>
        );
      })}
      {/* A confirm has no option rows: the two answers are drawn here, so the
          bold+accent one is what `y`/`n` and space select. */}
      {field.kind === 'confirm' ? (
        <Box>
          <Text>{' '}</Text>
          {CONFIRM_ANSWERS.map((answer) => (
            <Text
              key={answer.label}
              {...(answer.value === field.confirmed ? { bold: true } : {})}
              {...accent(answer.value === field.confirmed)}
            >
              {`${answer.label}  `}
            </Text>
          ))}
        </Box>
      ) : null}
      {field.kind === 'text' ? (
        <Box>
          <Text {...accent(true)}>{INPUT_CARET}</Text>
          <Text>{field.draft}</Text>
        </Box>
      ) : null}
      {field.error === undefined ? null : (
        <Text {...(color ? { color: 'yellow' } : { dimColor: true })}>
          {field.error}
        </Text>
      )}
      <Text dimColor>{`  ${helpText(field)}`}</Text>
    </Box>
  );
}

/**
 * The wizard viewport: the settled-summary panel + the live question.
 *
 * The settled lines live in a dim rounded panel (the dashboard's border
 * idiom), NOT in ink's `<Static>`: a Static block prints one bare line per
 * settled question as it happens, which cannot be framed as one summary, and
 * the recap block is what the human reads AFTER the wizard dies on a port
 * conflict. A live Box gives the box, and measurement (ink 6.8) shows it
 * survives `unmount()` exactly like Static did — ink's teardown flushes the
 * final frame and only ever clears the PREVIOUS one — so nothing is lost by
 * the switch. One blank line separates the panel from the live question, and
 * stays there when the wizard closes, splitting the panel from the `dev:`
 * error lines that follow.
 *
 * `alignItems="flex-start"` hugs the box to the widest settled line instead
 * of spanning the screen; long `(in use: …)` recaps still reflow inside it at
 * any width (measured at 100 and 60 columns).
 *
 * Pure (no hooks): the resize compensation re-renders it with
 * `renderToString` to learn the frame ink last drew.
 */
export function WizardView({
  state,
  color,
}: {
  state: WizardState;
  color: boolean;
}) {
  const hasPanel = state.lines.length > 0;
  return (
    <Box flexDirection="column" alignItems="flex-start">
      {hasPanel ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          borderDimColor
          paddingLeft={1}
        >
          {state.lines.map((line) => (
            <WizardLineView key={line.id} line={line} color={color} />
          ))}
        </Box>
      ) : null}
      {/* The panel OWNS its trailing blank line — its own line, not a margin
          and not a property of the live question. A real-PTY check caught the
          version that only spaced while a question was live: the wizard dying
          on a port conflict leaves no live question, the gap vanished with
          it, and the `dev:` error lines landed flush under the box bottom —
          the exact squash this panel exists to fix. */}
      {hasPanel ? <Text>{' '}</Text> : null}
      {state.field === null ? null : (
        <WizardFieldView field={state.field} color={color} />
      )}
    </Box>
  );
}

/** The live session: controller subscription + keystrokes over `WizardView`. */
export function WizardApp({ controller, color, onCommit }: WizardAppProps) {
  const [state, setState] = useState<WizardState>(controller.state);
  // Layout effects run in React's commit, the same pass that hands ink its
  // next frame, so this sees exactly the states ink was given to draw.
  useLayoutEffect(() => {
    onCommit?.(state);
  }, [state, onCommit]);
  useEffect(() => {
    const onChange = (): void => setState(controller.state());
    // Re-read on mount: the first question opens before ink's effects run, so
    // the state captured by useState may already be stale.
    setState(controller.state());
    return controller.subscribe(onChange);
  }, [controller]);
  useInput((input, key) => {
    controller.handleKey(input, key);
  });
  return <WizardView state={state} color={color} />;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface TuiPromptPortOptions {
  /** Render stream (defaults to `process.stdout`). */
  stdout?: NodeJS.WriteStream;
  /** Input stream (defaults to `process.stdin`). */
  stdin?: NodeJS.ReadStream;
  /** false renders plain (NO_COLOR); defaults to the NO_COLOR convention. */
  color?: boolean;
  /**
   * Whether the terminal re-wraps lines on a width change, which is when the
   * resize compensation is right; defaults to `terminalReflowsOnResize`.
   */
  reflowsOnResize?: boolean;
}

/** Show-cursor decseq: ink already writes it on teardown; this is the belt. */
const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * ink's own CI detection (its `is-in-ci` dependency, mirrored: Atlas does not
 * import ink's transitive deps). In CI mode ink neither draws live frames nor
 * listens for 'resize', so there is nothing on screen to compensate. Note an
 * EMPTY `CI` still counts. tests/cli/dev-tui-ci-parity.test.ts compares this
 * against the `is-in-ci` ink resolves, so an ink upgrade that changes the
 * detection fails there instead of deleting terminal rows.
 */
export function isInkCiMode(env: NodeJS.ProcessEnv): boolean {
  return ['CI', 'CONTINUOUS_INTEGRATION'].some(
    (key) => key in env && env[key] !== '0' && env[key] !== 'false'
  );
}

const inkCiMode = isInkCiMode(process.env);

/**
 * The `PromptPort` the dev wizard uses when the ink dashboard will mount. One
 * ink session spans the whole wizard; `close()` ends it and leaves stdin
 * raw-mode-off and paused so the dashboard can take the terminal over clean.
 */
export function createTuiPromptPort(
  options: TuiPromptPortOptions = {}
): PromptPort {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const color = options.color ?? colorAllowed(process.env);
  const controller = createWizardController();
  let instance: Instance | null = null;
  let closed = false;
  const reflows = options.reflowsOnResize ?? terminalReflowsOnResize(process.env);
  let lastColumns = stdout.columns;
  // The last two states React committed, newest last: ink's throttled draw
  // may lag its last commit by one frame, so either may be on screen.
  let committed: WizardState[] = [];
  const onCommit = (state: WizardState): void => {
    committed = [...committed.slice(-1), state];
  };

  // Ghost-frame fix (src/cli/dev-tui/reflow.ts has the why): on a shrink,
  // delete the rows the terminal re-wrapped the old frame into BEFORE ink's
  // own resize handler erases the rows it knows about. The old frame is
  // re-rendered at the old width: ink's live frame is its `output` string at
  // the terminal width, without the trailing newline it writes after it (the
  // cursor row reflowCompensation assumes), and `renderToString` returns that
  // same string for the same state. Both recently committed states are
  // rebuilt and the one that wrapped into FEWER extra rows wins: a ghost
  // border is the safe failure, deleting rows above the wizard is not.
  const onResize = (): void => {
    try {
      const columns = stdout.columns;
      // A size-less or detached reading neither compensates nor replaces the
      // last good width, so the next real shrink still measures from it.
      if (!isUsableSize(columns)) return;
      if (isUsableSize(lastColumns) && columns < lastColumns) {
        const frames = committed.map((state) =>
          renderToString(<WizardView state={state} color={color} />, {
            columns: lastColumns,
          })
        );
        const sequence = safestReflowCompensation(frames, columns, stdout.rows);
        if (sequence !== '') stdout.write(sequence);
      }
      lastColumns = columns;
    } catch {
      /* a compensation failure costs a ghost row, never the wizard */
    }
  };

  const app = () => (
    <WizardApp controller={controller} color={color} onCommit={onCommit} />
  );

  /** Mount on the first question: from then on the wizard owns the screen. */
  const mount = (): void => {
    if (instance !== null || closed) return;
    instance = render(app(), {
      stdout,
      stdin,
      // Ctrl-C must reach the controller (a cancel), never kill the process.
      exitOnCtrlC: false,
      // Nothing here logs; a patched console would be state to unwind on a
      // path the caller may abort.
      patchConsole: false,
    });
    // Nobody awaits the exit promise: swallow it so a render failure can never
    // surface as an unhandled rejection on top of the wizard's own error path.
    void instance.waitUntilExit().catch(() => undefined);
    // Prepended so it runs BEFORE ink's listener (registered by render above).
    // Only where the terminal is known to reflow: elsewhere ink's erase is
    // already exact and the compensation would delete real rows.
    if (reflows && !inkCiMode && stdout.isTTY === true) {
      lastColumns = stdout.columns;
      stdout.prependListener('resize', onResize);
    }
  };

  // Trailing comma on the type parameter: in a .tsx file `<T>` alone parses as JSX.
  const ask = async <T,>(
    request: WizardRequest
  ): Promise<PromptResult<T>> => {
    if (closed) return { status: 'cancelled' };
    // A Ctrl-C before this question already decided it: answer cancelled
    // without taking the screen again.
    if (controller.quitting()) return { status: 'cancelled' };
    // Mount BEFORE awaiting: the session renders the question the controller
    // is about to open (the state it reads on mount already carries it).
    const opened = controller.ask(request);
    mount();
    const answer = await opened;
    return answer.status === 'ok'
      ? { status: 'ok', value: answer.value as T }
      : { status: 'cancelled' };
  };

  /** One durable line: through the session when mounted, plain stdout after. */
  const line = (text: string, tone: 'note' | 'cancel'): void => {
    if (instance !== null) {
      if (tone === 'note') controller.note(text);
      else controller.cancelLine(text);
      return;
    }
    stdout.write(
      color
        ? `${paint(tone === 'note' ? SGR.dim : SGR.green, text)}\n`
        : `${text}\n`
    );
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    // A question still open means the caller is leaving without an answer:
    // cancel it so no wizard promise dangles.
    controller.quit();
    const current = instance;
    instance = null;
    stdout.off('resize', onResize);
    // A pathological ink teardown must not skip the terminal-restore below:
    // the cursor/raw-mode/pause cleanup is the whole point of close(), and
    // the dashboard mounts right after — a throw here would leave the human
    // with a hidden cursor and raw mode on.
    try {
      // The last answer's setState is still queued: React commits it in a
      // microtask, and the wizard's `await` resumes into this close() first.
      // Unmounting now would leave the frame with that question still live
      // and its recap missing from the panel (seen on a real PTY). A sync
      // rerender flushes the queued update so ink's final frame is current.
      current?.rerender(app());
      current?.unmount();
    } catch {
      /* ink's own cleanup failed; the belt-and-braces writes below still run */
    }
    // ink's teardown shows the cursor and drops raw mode already; both writes
    // below are the belt-and-braces half of the balance, and stdin must end
    // PAUSED for the dashboard's own takeover.
    stdout.write(SHOW_CURSOR);
    // The frame ink leaves standing ends wherever the last frame ended — with
    // the live question when the wizard died mid-flow (a real PTY showed the
    // `dev:` conflict lines landing flush under it). One blank line HERE puts
    // whatever the caller prints next below the standing frame; on the clean
    // path it is a single empty row before the plan lines, which reads fine.
    if (current !== null) stdout.write('\n');
    try {
      if (stdin.isTTY === true) {
        stdin.setRawMode(false);
        stdin.pause();
      }
    } catch {
      /* stdin is gone too */
    }
  };

  return {
    multiselect: (question) =>
      ask<string[]>({
        kind: 'multiselect',
        message: question.message,
        options: question.options,
        ...(question.initialValues !== undefined
          ? { initialValues: question.initialValues }
          : {}),
        ...(question.emptyHint !== undefined
          ? { emptyHint: question.emptyHint }
          : {}),
      }),
    select: (question) =>
      ask<string>({
        kind: 'select',
        message: question.message,
        options: question.options,
        ...(question.initialValue !== undefined
          ? { initialValue: question.initialValue }
          : {}),
      }),
    confirm: (question) =>
      ask<boolean>({
        kind: 'confirm',
        message: question.message,
        ...(question.initialValue !== undefined
          ? { initialValue: question.initialValue }
          : {}),
      }),
    text: (question) =>
      ask<string>({
        kind: 'text',
        message: question.message,
        ...(question.validate !== undefined
          ? { validate: question.validate }
          : {}),
      }),
    note: (message) => void line(message, 'note'),
    cancel: (message) => void line(message, 'cancel'),
    close,
  };
}
