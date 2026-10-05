// Resize compensation for the ink wizard (odd/tasks/wizard-tui-resize-and-
// conflict-panel.md, T2). PURE and stdlib-only: string math in, an escape
// sequence out; `wizard.tsx` decides when to write it.
//
// Why it exists: on a width DECREASE ink 6.8 (`Ink.resized`) calls
// `log.clear()`, which erases exactly the rows ink wrote — the frame's lines
// plus the cursor row below them. The terminal emulator has already
// re-wrapped every line wider than the new width, so the old frame now spans
// MORE rows than ink erases and its top rows (the panel's `╭───╮` border,
// first of all) survive as ghosts above the redrawn frame. Writing the
// sequence below right BEFORE ink's clear deletes those extra rows, so ink's
// own erase then lands on exactly what is left.
//
// Width model: one column per code point. The wizard draws ASCII, box-drawing
// and the `●✓▍›` glyphs, all width 1 in every terminal it targets; wide (CJK)
// or zero-width characters in an app name would only make the count
// approximate, never break the wizard.

const ESC = String.fromCharCode(0x1b);

// CSI sequences (SGR and friends) take no columns. Built at runtime: the
// no-control-regex lint rule forbids an ESC literal inside a regex.
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

function visibleWidth(line: string): number {
  return [...line.replace(CSI, '')].length;
}

/** The frame's lines, without the empty segment after a trailing newline. */
function frameLines(frame: string): string[] {
  if (frame === '') return [];
  const lines = frame.split('\n');
  if (frame.endsWith('\n')) lines.pop();
  return lines;
}

/** A usable terminal dimension: a stream that reports no size gives
 * `undefined` (NaN in the math below), a detached one 0. */
export function isUsableSize(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Rows the compensation for `frame` deletes (0: nothing to write). */
function extraRows(frame: string, newColumns: number, screenRows: number): number {
  if (!isUsableSize(newColumns) || !isUsableSize(screenRows)) return 0;
  const lines = frameLines(frame).length;
  if (lines === 0) return 0;
  const up = Math.min(reflowedRows(frame, newColumns), screenRows - 1);
  return Math.max(0, up - lines);
}

/**
 * Rows `frame` occupies once a terminal `columns` wide has re-wrapped it:
 * every line takes `ceil(width / columns)` rows, an empty line still one.
 * An unusable width (non-finite or <= 0) wraps nothing: one row per line.
 */
export function reflowedRows(frame: string, columns: number): number {
  const lines = frameLines(frame);
  if (!isUsableSize(columns)) return lines.length;
  const width = Math.max(1, columns);
  return lines.reduce(
    (rows, line) => rows + Math.max(1, Math.ceil(visibleWidth(line) / width)),
    0
  );
}

/**
 * The sequence to write BEFORE ink's own clear after the terminal shrank to
 * `newColumns`, or `''` when nothing extra wrapped. Assumes ink's layout: the
 * `frame` (F lines, no trailing newline — what ink's `output` holds) and the
 * cursor on the empty row right below it.
 *
 * With R = reflowed rows: carriage return, climb `up = min(R, screenRows - 1)`
 * rows to the top of the re-wrapped frame (never past the screen top), delete
 * the `up - F` rows ink will not erase (`CSI n M` pulls the rest up, so no
 * blank gap is left), then step back down F rows to the cursor row ink
 * expects. ink's clear then erases the remaining F rows plus the cursor row.
 *
 * `''` too when `newColumns` or `screenRows` is not a finite positive number:
 * `wizard.tsx` passes `stdout.columns` / `stdout.rows` unchecked, and a
 * guessed climb would delete rows that are not the frame's.
 */
export function reflowCompensation(
  frame: string,
  newColumns: number,
  screenRows: number
): string {
  const extra = extraRows(frame, newColumns, screenRows);
  if (extra === 0) return '';
  const lines = frameLines(frame).length;
  const up = lines + extra;
  return `\r${ESC}[${up}A${ESC}[${extra}M${ESC}[${lines}B`;
}

/**
 * `reflowCompensation` for whichever of `frames` wrapped into the FEWEST
 * extra rows (`''` for none, or when any of them needs nothing). The wizard
 * passes the last two frames React committed: ink's throttled draw may lag
 * its last commit by one frame, so either may be what is on screen, and
 * under-deleting leaves a ghost border while over-deleting eats real rows
 * above the wizard (the banner, the shell prompt).
 */
export function safestReflowCompensation(
  frames: readonly string[],
  newColumns: number,
  screenRows: number
): string {
  let safest: string | undefined;
  let fewest = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const extra = extraRows(frame, newColumns, screenRows);
    if (extra < fewest) {
      fewest = extra;
      safest = frame;
    }
  }
  return safest === undefined ? '' : reflowCompensation(safest, newColumns, screenRows);
}

// Emulators known to re-wrap the visible screen when the width shrinks: the
// only place the compensation is right. CONSERVATIVE on purpose: on a
// terminal that does not reflow (plain xterm, the Linux console, GNU screen),
// the old frame still spans F rows, ink's own erase is exact, and deleting
// "extra" rows would eat real output above the wizard. An unknown terminal
// keeps a possible ghost border instead. Values are what each emulator
// exports itself: iTerm2 `TERM_PROGRAM=iTerm.app`, Terminal.app
// `Apple_Terminal`, Ghostty `TERM_PROGRAM=ghostty` + `TERM=xterm-ghostty` +
// `GHOSTTY_RESOURCES_DIR`, WezTerm `TERM_PROGRAM=WezTerm` + `WEZTERM_PANE`
// (`TERM=wezterm` only when configured), kitty `TERM=xterm-kitty` +
// `KITTY_WINDOW_ID`, Alacritty `TERM=alacritty`, and the xterm.js hosts
// (VS Code `vscode`, Tabby, Hyper), whose buffer reflows on resize.
//
// tmux is IN: the multiplexer, not the outer emulator, owns the pane grid,
// and tmux re-wraps it on a resize (its grid reflow, on by default since
// 2.x); tmux >= 3.2 exports `TERM_PROGRAM=tmux`. An older tmux inherits the
// outer `TERM_PROGRAM`, which is only right because tmux reflows too.
// GNU screen is OUT, markers or not: it owns the grid inside any emulator and
// its rewrap is not something to bet rows on; `STY` marks a screen session
// and overrides every marker inherited from the outer emulator.
const REFLOWING_TERM_PROGRAMS = new Set([
  'iTerm.app',
  'Apple_Terminal',
  'ghostty',
  'WezTerm',
  'vscode',
  'Tabby',
  'Hyper',
  'tmux',
]);
const REFLOWING_TERMS = new Set(['xterm-kitty', 'xterm-ghostty', 'alacritty', 'wezterm']);
const REFLOWING_MARKERS = ['KITTY_WINDOW_ID', 'WEZTERM_PANE', 'GHOSTTY_RESOURCES_DIR'];

/** Whether the terminal `env` describes re-wraps lines on a width change. */
export function terminalReflowsOnResize(env: NodeJS.ProcessEnv): boolean {
  const present = (key: string): boolean => (env[key] ?? '') !== '';
  if (present('STY')) return false;
  return (
    REFLOWING_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? '') ||
    REFLOWING_TERMS.has(env.TERM ?? '') ||
    REFLOWING_MARKERS.some(present)
  );
}
