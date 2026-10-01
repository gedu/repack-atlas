// Pure view-model for the interactive `dev` dashboard
// (odd/tasks/dev-tui-dashboard.md T2). The ink layer (`app.tsx`, T3) renders
// this and nothing else, so this module imports NO ink, NO react and NO node
// builtins at runtime — the two imports below are `import type` only and are
// erased by tsc. Every behavior is deterministic data-in / data-out, unit
// tested in `tests/cli/dev-tui-model.test.ts`.
//
// Contract with the supervisor (`src/runner/supervisor.ts`): `log`, `status`
// and `oneShot` mirror `SupervisorEvents.onLog/onStatus/onOneShot` 1:1 so the
// T4 seam can forward events verbatim. The `app` identifier is whatever the
// supervisor emits — the graph node NAME — so each row answers to both its
// plan config key and its name.
//
// Deliberate choices (documented decisions of this task):
// - Logs for an app outside the roster are REJECTED (`log` returns false):
//   the plan is complete before anything is supervised, so an unknown name is
//   a bug — silently inventing a mid-render row would hide it.
// - The model never calls `Date`: `log` accepts an optional `at` timestamp the
//   caller supplies (T4 passes `Date.now()`). Absent means no timestamp; tests
//   stay deterministic because time is data, never behavior.
// - Navigation CLAMPS at the ends instead of wrapping: `Next` on the last row
//   stays on it — predictable for a short roster.
// - One-shot statuses stay honest: `exited` only for a clean exit code 0;
//   a non-zero code, a signal kill or a failed spawn all map to `error`.

import type { AppRuntimeStatus } from '../../core/index.js';
import type { OneShotEvent } from '../../runner/supervisor.js';

/** Per-app ring-buffer cap (lines kept; older lines drop, counted as hidden). */
export const DEV_TUI_RING_CAP = 2000;

/** Roster status space: the live app statuses plus the two the model adds. */
export type DevTuiStatus = AppRuntimeStatus | 'pending' | 'exited';

/** Ink color tokens the T3 layer maps to `<Text color={...}>`. `blue`
 * exists for the Re.Pack console palette (F5): the info glyph `ℹ`. */
export type DevTuiColor = 'green' | 'yellow' | 'red' | 'cyan' | 'gray' | 'blue';

/** Classification of one log line, for coloring (heuristic, presentation only). */
export type LineKind = 'info' | 'success' | 'warn' | 'error' | 'progress';

export type LogStream = 'stdout' | 'stderr';

/** Status → icon/color map (rule from the task file: the UI stays dumb). */
export const STATUS_PRESENTATION: Record<
  DevTuiStatus,
  { glyph: string; color: DevTuiColor }
> = {
  pending: { glyph: '○', color: 'gray' },
  idle: { glyph: '○', color: 'gray' },
  starting: { glyph: '●', color: 'yellow' },
  bundling: { glyph: '●', color: 'yellow' },
  ready: { glyph: '✓', color: 'green' },
  error: { glyph: '✗', color: 'red' },
  stopped: { glyph: '○', color: 'gray' },
  exited: { glyph: '→', color: 'cyan' },
};

export function statusPresentation(
  status: DevTuiStatus
): { glyph: string; color: DevTuiColor } {
  return STATUS_PRESENTATION[status];
}

// ---------------------------------------------------------------------------
// Classification (exported pure for tests)
// ---------------------------------------------------------------------------

const BRAILLE = /[\u2800-\u28FF]/;
const ERROR_MARK = /×|✗|\[timeout\]/i;
const WARN_MARK = /⚠/;
const SUCCESS_MARK = /^[✓√]|^success\b/i;
const ERROR_WORD = /\berror\b/i;
const WARN_WORD = /\bwarning\b|\bwarn\b/i;
const PROGRESS_BAR = /\[[^\]]*[=\-█▓▒░]{2,}[^\]]*\]/;
const PERCENT = /\d+(?:\.\d+)?%/;
const TRAILING_DOTS = /\.{2,}$/;

/**
 * Heuristic kind of one raw log line, keyed on the child's OWN markers
 * (Re.Pack/RN CLIs print `✓`/`×`/`⚠`/`ℹ` themselves). Order matters: an
 * explicit error marker beats the progress shape, so `× ... [timeout] ...`
 * never reads as progress. Unknown lines are `info` — never guess louder.
 */
export function classifyLine(text: string): LineKind {
  const t = text.trim();
  if (ERROR_MARK.test(t) || ERROR_WORD.test(t)) return 'error';
  if (WARN_MARK.test(t) || WARN_WORD.test(t)) return 'warn';
  if (SUCCESS_MARK.test(t)) return 'success';
  if (BRAILLE.test(t) || PROGRESS_BAR.test(t) || TRAILING_DOTS.test(t)) {
    return 'progress';
  }
  return 'info';
}

// ---------------------------------------------------------------------------
// Log window + progress-bar pinning (exported pure for tests; app.tsx renders)
// ---------------------------------------------------------------------------

/**
 * Window `[start, end)` of the lines to render for a scroll offset counted
 * FROM THE BOTTOM (0 = autoscroll at the bottom). The offset is clamped so
 * at least one line stays visible when the buffer is shorter than asked.
 */
export function logWindow(
  total: number,
  offset: number,
  pageHeight: number
): { start: number; end: number } {
  const clamped = Math.min(Math.max(0, offset), Math.max(0, total - 1));
  const end = total - clamped;
  const start = Math.max(0, end - Math.max(1, pageHeight));
  return { start, end };
}

/** How close to the buffer's end a progress frame must appear for the bar to
 * still count as ACTIVE (F4). Beyond this many quiet lines the last bar frame
 * is history, not a live pin — a stale 93% bar must never sit at the bottom
 * forever once `Compiled` and later lines have flowed past it. */
export const PROGRESS_PIN_RECENCY = 3;

/** Progress SHAPE: a braille spinner glyph or a bracketed bar with fill
 * chars, classified as `progress`. Dotted spinner lines (`Building…....`)
 * are deliberately NOT progress-shaped — they animate in place (F3) and
 * belong to the normal body flow. */
export function isProgressShaped(line: DevTuiLine): boolean {
  if (line.kind !== 'progress') return false;
  return BRAILLE.test(line.text) || PROGRESS_BAR.test(line.text);
}

/** A pinned bar plus the lines that render as the panel body (everything
 * except the pinned line). */
export interface DevTuiPinnedPartition {
  pinned: DevTuiLine | undefined;
  body: DevTuiLine[];
}

/**
 * F4 pin rule: `pinned` = the LAST progress-shaped line, but only while it
 * still sits within the last `recency` lines of the buffer — i.e. the
 * animation is active (frames collapse IN PLACE, so a live bar is always at
 * or near the end). Once `Compiled` and later lines push the bar past that
 * window it unpins and flows as normal history: a stale 93% frame never
 * stays parked at the bottom.
 */
export function partitionPinned(
  lines: readonly DevTuiLine[],
  recency: number = PROGRESS_PIN_RECENCY
): DevTuiPinnedPartition {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || !isProgressShaped(line)) continue;
    if (i < lines.length - Math.max(1, recency)) break; // stale: history
    return { pinned: line, body: lines.filter((_, j) => j !== i) };
  }
  return { pinned: undefined, body: [...lines] };
}

// Fill chars inside a bracketed bar, in the order a growing bar uses them.
const BAR_RUN_IN_TEXT = /\[([^\]]*[=\-█▓▒░#][^\]]*)\]/;
const LAST_PERCENT = /(\d{1,3}(?:\.\d+)?)%(?![\d.]*%)/;

/**
 * Bar-graphics normalization (F4): when the printed percent says exactly 100
 * but the child's last frame still shows a PARTIAL fill, expand the fill to
 * the full bracket width. This only redraws what the child already declared
 * (`100%`) — when the percent is below 100 (or absent) the text is returned
 * verbatim; a completion the child did not print is never invented.
 */
export function renderProgressFrame(text: string): string {
  const bar = BAR_RUN_IN_TEXT.exec(text);
  const percent = LAST_PERCENT.exec(text);
  if (bar === null || bar.index === undefined || percent === null) {
    return text;
  }
  if (Number.parseFloat(percent[1] as string) !== 100) return text;
  const inner = bar[1];
  if (inner === undefined) return text;
  const full = '█'.repeat(inner.length);
  if (inner === full) return text;
  return `${text.slice(0, bar.index)}[${full}]${text.slice(bar.index + bar[0].length)}`;
}

// ---------------------------------------------------------------------------
// Spinner-frame collapsing (exported pure for tests)
// ---------------------------------------------------------------------------

/** Children pipe their stdout, so every animation frame is one line; lines
 * at or above this length are real output, never a frame. */
const MAX_COLLAPSIBLE_LENGTH = 120;

/** Anything meaningful must never be swallowed by a collapse: errors,
 * warnings and links (e.g. manifest URLs) are hard stops. */
const NEVER_COLLAPSE = /(error|warning|⚠|×|✗|https?:)/i;

const TIMESTAMP = /\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?Z?/g;
const PERCENT_RUN = /\d+(?:\.\d+)?%/g;
const BAR_RUN = /[=\-█▓▒░#]{2,}/g;

/**
 * Normalization shared by candidate detection and live matching: strip
 * timestamps and spinner glyphs, squash progress-bar runs to `#` and any
 * percentage to `%`, drop up to 6 trailing dots, collapse whitespace.
 * Also reports whether the ORIGINAL text looks like animation (a braille
 * glyph, a percentage, a bracketed bar, or trailing dots) — plain identical
 * lines must NOT collapse, only frames do.
 */
function normalizeKey(raw: string): { key: string; animated: boolean } {
  const trimmed = raw.trim();
  let k = trimmed
    .replace(TIMESTAMP, ' ')
    .replace(/[\u2800-\u28FF]/g, '')
    .replace(BAR_RUN, '#')
    .replace(PERCENT_RUN, '%');
  const dots = /\.+$/.exec(k);
  if (dots !== null && dots[0].length <= 6) {
    k = k.slice(0, k.length - dots[0].length);
  }
  k = k.replace(/\s+/g, ' ').trim();
  const animated =
    BRAILLE.test(trimmed) ||
    PERCENT.test(trimmed) ||
    PROGRESS_BAR.test(trimmed) ||
    /\.{1,6}$/.test(trimmed);
  return { key: k, animated };
}

/**
 * Collapse key of one line when it looks like a transient animation frame,
 * `undefined` otherwise. Conservative by construction (task rule 3): the line
 * must be non-empty, shorter than 120 chars, free of error/warning/link
 * markers, and animation-looking (dots-only, spinner glyph or percentage
 * progress). Two frames of the same animation normalize to the same key.
 */
export function collapseCandidate(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length >= MAX_COLLAPSIBLE_LENGTH) {
    return undefined;
  }
  if (NEVER_COLLAPSE.test(trimmed)) return undefined;
  const { key, animated } = normalizeKey(trimmed);
  return animated ? key : undefined;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One sidebar row (apps carry the plan's port; the one-shot carries none). */
export interface DevTuiRow {
  /** Plan config key (`host`, the remote name, or the one-shot name). */
  key: string;
  /** Graph node name (what the supervisor emits in `onLog`/`onStatus`). */
  name: string;
  role: 'host' | 'remote' | 'oneshot';
  port?: number;
  /** Port `--auto-ports` moved this app away from (note for the sidebar). */
  reassignedFrom?: number;
  status: DevTuiStatus;
  pid?: number;
}

/** A row plus everything the ink layer needs to render it without thinking. */
export interface DevTuiRenderRow extends DevTuiRow {
  glyph: string;
  color: DevTuiColor;
  /** e.g. `8082 (was 8081)` when the port was reassigned. */
  portLabel?: string;
}

/** One kept log line. `live: true` marks the collapsing line being updated. */
export interface DevTuiLine {
  stream: LogStream;
  text: string;
  kind: LineKind;
  at?: number;
  live?: true;
}

/** One plan app as the roster is built (structurally a `DevAppPlan`). */
export interface DevTuiRosterEntry {
  key: string;
  name: string;
  role: 'host' | 'remote';
  port?: number;
  reassignedFrom?: number;
}

export interface DevTuiModelOptions {
  /** The planned apps; display order is enforced: host, remotes (plan order). */
  apps: readonly DevTuiRosterEntry[];
  /** The one-shot row's name (`launch`) — pass only when a launch plan exists. */
  launchName?: string;
  /** Ring-buffer cap override (tests use tiny caps). */
  ringCap?: number;
}

/** The whole UI state in one object (T3 renders it as-is). */
export interface DevTuiSnapshot {
  rows: DevTuiRenderRow[];
  selectedIndex: number;
  selectedKey?: string;
  lines: DevTuiLine[];
  /** Lines dropped from the selected app's buffer by the ring cap. */
  hiddenLines: number;
}

export interface DevTuiModel {
  /** Mirror of `onLog`. False when `app` is not in the roster (rejected). */
  log(app: string, stream: LogStream, line: string, at?: number): boolean;
  /** Mirror of `onStatus`. False when `app` is unknown or the one-shot row. */
  status(app: string, status: AppRuntimeStatus, port?: number, pid?: number): boolean;
  /** Mirror of `onOneShot`. Only the oneshot row answers. */
  oneShot(name: string, event: OneShotEvent): boolean;

  /** Row copies in display order. */
  rows(): DevTuiRow[];
  /** Rows with icon/color/portLabel precomputed. */
  visibleRows(): DevTuiRenderRow[];
  selectedIndex(): number;
  selectedRow(): DevTuiRow | undefined;
  selectedLines(): DevTuiLine[];
  selectedHiddenCount(): number;
  /** Key or name lookup; false (and no move) when unknown. */
  selectKey(keyOrName: string): boolean;
  selectFirst(): void;
  selectLast(): void;
  /** Clamp (no wrap). */
  selectNext(): void;
  /** Clamp (no wrap). */
  selectPrev(): void;
  /** Log copies for `app` (key or name); empty when unknown. */
  lines(app: string): DevTuiLine[];
  hiddenCount(app: string): number;
  snapshot(): DevTuiSnapshot;
}

interface LineRecord {
  stream: LogStream;
  text: string;
  kind: LineKind;
  at?: number;
  live?: boolean;
  /** Normalized key, kept for previous-frame matching. */
  key: string;
}

interface RowState {
  row: DevTuiRow;
  lines: LineRecord[];
  hidden: number;
}

function toPublicLine(record: LineRecord): DevTuiLine {
  return {
    stream: record.stream,
    text: record.text,
    kind: record.kind,
    ...(record.at !== undefined ? { at: record.at } : {}),
    ...(record.live === true ? { live: true as const } : {}),
  };
}

function toRenderRow(row: DevTuiRow): DevTuiRenderRow {
  const presentation = statusPresentation(row.status);
  return {
    ...row,
    glyph: presentation.glyph,
    color: presentation.color,
    ...(row.port !== undefined
      ? {
          portLabel:
            row.reassignedFrom !== undefined
              ? `${row.port} (was ${row.reassignedFrom})`
              : `${row.port}`,
        }
      : {}),
  };
}

/** One-shot event → row status (honest vocabulary, see header). */
function oneShotStatus(event: OneShotEvent): DevTuiStatus {
  if (event.status === 'started') return 'starting';
  if (event.status === 'exited' && event.code === 0) return 'exited';
  return 'error';
}

export function createDevTuiModel(
  options: DevTuiModelOptions
): DevTuiModel {
  const ringCap = options.ringCap ?? DEV_TUI_RING_CAP;

  // Fixed display order: host first, remotes in plan order, one-shot last.
  const ordered = [
    ...options.apps.filter((app) => app.role === 'host'),
    ...options.apps.filter((app) => app.role === 'remote'),
  ];
  const states: RowState[] = ordered.map((app) => ({
    row: {
      key: app.key,
      name: app.name,
      role: app.role,
      ...(app.port !== undefined ? { port: app.port } : {}),
      ...(app.reassignedFrom !== undefined
        ? { reassignedFrom: app.reassignedFrom }
        : {}),
      status: 'pending' as DevTuiStatus,
    },
    lines: [],
    hidden: 0,
  }));
  if (options.launchName !== undefined) {
    states.push({
      row: {
        key: options.launchName,
        name: options.launchName,
        role: 'oneshot',
        status: 'pending',
      },
      lines: [],
      hidden: 0,
    });
  }

  // Rows answer to key AND name (the supervisor emits graph names). First
  // registration wins on a collision — plan keys/names are unique per row.
  const index = new Map<string, RowState>();
  for (const state of states) {
    if (!index.has(state.row.key)) index.set(state.row.key, state);
    if (!index.has(state.row.name)) index.set(state.row.name, state);
  }

  let selection = states.length > 0 ? 0 : -1;
  const clamp = (i: number): number =>
    Math.max(0, Math.min(Math.max(states.length - 1, 0), i));
  const stateAt = (i: number): RowState | undefined =>
    i >= 0 && i < states.length ? states[i] : undefined;

  function indexOfState(state: RowState): number {
    return states.findIndex((candidate) => candidate === state);
  }

  function appendLine(
    state: RowState,
    stream: LogStream,
    line: string,
    at?: number
  ): void {
    const { key } = normalizeKey(line);
    const last = state.lines[state.lines.length - 1];
    const collapsible =
      last !== undefined &&
      last.stream === stream &&
      last.key === key &&
      line.trim() !== '' &&
      line.length < MAX_COLLAPSIBLE_LENGTH &&
      !NEVER_COLLAPSE.test(line) &&
      // A frame (candidate), or the FINAL frame after a live line: the same
      // text once the animation dots stop (path B).
      (collapseCandidate(line) !== undefined || last.live === true);
    if (last !== undefined && collapsible) {
      // Replace the previous frame IN PLACE: one updating line, original
      // insertion position kept.
      last.text = line;
      last.kind = classifyLine(line);
      last.live = true;
      if (at !== undefined) last.at = at;
      return;
    }
    if (last !== undefined) last.live = false;
    state.lines.push({
      stream,
      text: line,
      kind: classifyLine(line),
      ...(at !== undefined ? { at } : {}),
      // A first frame is already live: the animation may keep updating it.
      ...(collapseCandidate(line) !== undefined ? { live: true } : {}),
      key,
    });
    if (state.lines.length > ringCap) {
      state.lines.shift();
      state.hidden += 1;
    }
  }

  return {
    log(app, stream, line, at) {
      const state = index.get(app);
      if (state === undefined) return false;
      appendLine(state, stream, line, at);
      return true;
    },
    status(app, status, port, pid) {
      const state = index.get(app);
      // App statuses never touch the one-shot row: its lifecycle is the
      // OneShotEvent stream alone.
      if (state === undefined || state.row.role === 'oneshot') return false;
      state.row.status = status;
      if (port !== undefined) state.row.port = port;
      if (pid !== undefined) state.row.pid = pid;
      return true;
    },
    oneShot(name, event) {
      const state = index.get(name);
      if (state === undefined || state.row.role !== 'oneshot') return false;
      state.row.status = oneShotStatus(event);
      if (event.status === 'started' && event.pid !== null) {
        state.row.pid = event.pid;
      }
      return true;
    },
    rows() {
      return states.map((state) => ({ ...state.row }));
    },
    visibleRows() {
      return states.map((state) => toRenderRow(state.row));
    },
    selectedIndex() {
      return selection;
    },
    selectedRow() {
      const state = stateAt(selection);
      return state === undefined ? undefined : { ...state.row };
    },
    selectedLines() {
      const state = stateAt(selection);
      return state === undefined ? [] : state.lines.map(toPublicLine);
    },
    selectedHiddenCount() {
      return stateAt(selection)?.hidden ?? 0;
    },
    selectKey(keyOrName) {
      const state = index.get(keyOrName);
      if (state === undefined) return false;
      selection = indexOfState(state);
      return selection >= 0;
    },
    selectFirst() {
      if (states.length > 0) selection = 0;
    },
    selectLast() {
      if (states.length > 0) selection = states.length - 1;
    },
    selectNext() {
      if (states.length > 0) selection = clamp(selection + 1);
    },
    selectPrev() {
      if (states.length > 0) selection = clamp(selection - 1);
    },
    lines(app) {
      return index.get(app)?.lines.map(toPublicLine) ?? [];
    },
    hiddenCount(app) {
      return index.get(app)?.hidden ?? 0;
    },
    snapshot() {
      const row = selection >= 0 ? states[selection] : undefined;
      return {
        rows: states.map((state) => toRenderRow(state.row)),
        selectedIndex: selection,
        ...(row !== undefined ? { selectedKey: row.row.key } : {}),
        lines: row !== undefined ? row.lines.map(toPublicLine) : [],
        hiddenLines: row?.hidden ?? 0,
      };
    },
  };
}
