// Busy-port panel for human `dev` runs (odd/tasks/wizard-tui-resize-and-
// conflict-panel.md, T3). PURE and stdlib-only — no ink, no react, no color
// library (AGENTS.md rule 11; dev.ts imports this statically and must stay
// free of ink/react, see tests/cli/dev-tui-seam.test.ts). `dev.ts` decides
// WHEN to print it (human TTY path, port conflict only); this module only
// renders a string.
//
// Shape: the wizard's summary panel (rounded `╭─╮│╰╯`, one space of left
// padding, hugging the widest line) so the conflict reads as one block under
// the wizard's recap instead of bare lines. The `dev:` lines go in verbatim;
// only a line wider than the terminal is word-wrapped.
//
// Width model: one column per code point (the lines are ASCII; the border
// glyphs are width 1).

const ESC = String.fromCharCode(0x1b);

/** Hand-rolled SGR subset (rule 11). Dim yellow (`2;33`) is the soft,
 * muted yellow: the 16-color yellow follows the user's own palette and dim
 * mutes it, so it reads as "attention" without the bright-yellow shout, and
 * it works on 16-color terminals where an ansi256 tone (e.g. 179) would not. */
const SGR = {
  reset: '[0m',
  dimYellow: '[2;33m',
} as const;

function paint(codes: string, text: string): string {
  return `${ESC}${codes}${text}${ESC}${SGR.reset}`;
}

function widthOf(text: string): number {
  return [...text].length;
}

/** Greedy word wrap at `width`; a word longer than `width` is hard-broken. */
function wrap(line: string, width: number): string[] {
  if (widthOf(line) <= width) return [line];
  const rows: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (widthOf(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== '') rows.push(current);
    let rest = [...word];
    while (rest.length > width) {
      rows.push(rest.slice(0, width).join(''));
      rest = rest.slice(width);
    }
    current = rest.join('');
  }
  if (current !== '') rows.push(current);
  return rows;
}

export interface ConflictPanelOptions {
  /** Terminal columns: the box never grows past them. */
  columns: number;
  /** False renders with zero escape bytes (NO_COLOR). */
  color: boolean;
}

/**
 * The panel, newline-joined (no trailing newline: the caller's `writeErr`
 * ends the last row). Only the border is painted; the text keeps the
 * terminal's default foreground.
 */
export function renderConflictPanel(
  lines: readonly string[],
  options: ConflictPanelOptions
): string {
  const border = (text: string): string =>
    options.color ? paint(SGR.dimYellow, text) : text;
  // `│ ` + text + `│`: three columns of chrome around the text.
  const cap = Math.max(1, options.columns - 3);
  const widest = Math.max(0, ...lines.map(widthOf));
  const inner = Math.min(widest, cap);
  const rows = lines.flatMap((line) => wrap(line, inner));
  const rule = '─'.repeat(inner + 1);
  return [
    border(`╭${rule}╮`),
    ...rows.map(
      (row) =>
        `${border('│')} ${row}${' '.repeat(inner - widthOf(row))}${border('│')}`
    ),
    border(`╰${rule}╯`),
  ].join('\n');
}

export interface PortConflictFrameInputs {
  /** The human TUI path is active (dev.ts `tuiCondition`). */
  tuiCondition: boolean;
  /** The plan failed on busy ports. */
  portConflict: boolean;
  /** stderr, where the panel is written, is a terminal (`2> file` is not). */
  stderrIsTTY: boolean;
}

/** Whether a failed plan's reasons go out framed: a port conflict on the
 * human TUI path, written to a terminal. Everything else stays bare lines. */
export function shouldFramePortConflict(inputs: PortConflictFrameInputs): boolean {
  return inputs.tuiCondition && inputs.portConflict && inputs.stderrIsTTY;
}

export interface PlanFailureOptions extends ConflictPanelOptions {
  /** True renders the panel (see `shouldFramePortConflict`). */
  framed: boolean;
}

/**
 * The `writeErr` payloads for a failed plan: one `dev: <reason>` line per
 * reason when not framed (byte for byte what dev.ts always printed), or a
 * single panel holding those same lines.
 */
export function formatPlanFailure(
  reasons: readonly string[],
  options: PlanFailureOptions
): string[] {
  const lines = reasons.map((reason) => `dev: ${reason}`);
  if (!options.framed) return lines;
  return [
    renderConflictPanel(lines, { columns: options.columns, color: options.color }),
  ];
}
