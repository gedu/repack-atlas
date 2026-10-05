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
function isUsableSize(value: number): boolean {
  return Number.isFinite(value) && value > 0;
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
  if (!isUsableSize(newColumns) || !isUsableSize(screenRows)) return '';
  const lines = frameLines(frame).length;
  const up = Math.min(reflowedRows(frame, newColumns), screenRows - 1);
  const extra = up - lines;
  if (lines === 0 || extra <= 0) return '';
  return `\r${ESC}[${up}A${ESC}[${extra}M${ESC}[${lines}B`;
}
