// Ink dashboard for interactive `dev` sessions
// (odd/tasks/dev-tui-dashboard.md T3, F1-F5 polish). PURE rendering layer: it
// receives the pure `DevTuiModel` (T2) plus control callbacks and renders a
// sidebar (apps + status glyphs + ports) and a log panel for the selected
// row. It imports NO supervisor, fs or process logic. The machine paths
// (`--json`, `--ci`, non-TTY) must never import ink/react (AGENTS.md rule 11
// exception (b)), so the T4 seam dynamic-imports exactly this module once a
// session is human-interactive. Quit (`q`, Ctrl-C) and Studio (`v`, `o`) are
// callbacks only — shutdown sequencing, alt-screen and raw-mode ownership
// stay in `dev.ts`. The model is mutable and event-fed, so the component
// re-reads `model.snapshot()` on a small fixed tick instead of pushing
// renders from the event source. Requires ink
// `render(..., { exitOnCtrlC: false })` so Ctrl-C reaches `onQuit` instead of
// ink killing the process.
//
// F1 (wheel routing): the terminal reports the wheel only as arrow keys (or
// scrolls its own scrollback) unless the app asks for mouse reporting, so the
// mount effect turns on DECSET 1000 + SGR 1006 and the teardown turns them
// off. Ink's input parser hands unknown CSI sequences to `useInput` verbatim
// (only the leading ESC is stripped — verified against ink 6.8), so the SGR
// wheel bytes (`\x1b[<64;col;rowM` up / `65` down, plus `m` releases) are
// parsed here and routed by column: over the sidebar a notch moves the
// selection, over the panel it scrolls the log. Real arrow keys stay on
// `key.upArrow/downArrow` with an empty `input`, so wheel and keys never
// collide. COST of mouse capture: native click-drag text selection needs the
// terminal's bypass modifier (Shift on most terminals) — the footer says so.

import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useState } from 'react';
import {
  type DevTuiColor,
  type DevTuiLine,
  type DevTuiModel,
  type LineKind,
  logWindow,
  partitionPinned,
  renderProgressFrame,
} from './model.js';

/** Sidebar column width, including its right border (layout contract). */
export const SIDEBAR_WIDTH = 24;

/** How often the view re-reads the model (ms). Input re-renders on its own.
 * Also drives the F3 dot animation frame counter (one tick = one frame). */
export const DEV_TUI_FRAME_MS = 100;

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const HELP_LINES = 3;
const HELP_KEYS = '↑↓ select · PgUp scroll';
const HELP_WHEEL = 'wheel · shift+drag copy';
/** Log lines a wheel notch scrolls (F1). */
const WHEEL_SCROLL_LINES = 3;

/** DECSET codes written on mount/teardown (F1): 1000 = click/release
 * reporting, 1006 = SGR coordinates (the extended form we parse). */
const MOUSE_TRACKING_ON = '\u001b[?1000h\u001b[?1006h';
const MOUSE_TRACKING_OFF = '\u001b[?1000l\u001b[?1006l';

export interface DevTuiAppProps {
  /** Pure view-model the seam feeds with log/status/oneShot events. */
  model: DevTuiModel;
  /** `q` / Ctrl-C. The seam owns shutdown; this component never exits. */
  onQuit: () => void;
  /** `v` / `o`. Pass only when the session has a Studio; hides the hint. */
  onOpenStudio?: () => void;
  /** Fixed F3 animation frame (tests); omit to drive it from the 100ms tick. */
  frame?: number;
}

// ---------------------------------------------------------------------------
// Pure view helpers (exported for tests; the model owns all real logic)
// ---------------------------------------------------------------------------

/** Hard-truncate to `maxWidth` chars with a single trailing ellipsis. */
export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  return `${text.slice(0, maxWidth - 1)}…`;
}

/** Re.Pack console palette (F5): the level SYMBOL carries the color, the
 * message stays the default foreground. `info` is blue (the `ℹ` glyph). */
export function lineColor(kind: LineKind): DevTuiColor | undefined {
  switch (kind) {
    case 'success':
      return 'green';
    case 'warn':
      return 'yellow';
    case 'error':
      return 'red';
    case 'progress':
      return 'green';
    case 'info':
      return 'blue';
  }
}

/** Glyph Re.Pack's reporter shows per level (F5), used only when the child
 * printed no symbol of its own. `info` is deliberately absent: inventing an
 * `ℹ` on every plain line would dirty the copy (F2) for no signal. */
const AUTO_GLYPH: Record<LineKind, string | undefined> = {
  info: undefined,
  warn: '⚠',
  error: '✖',
  success: '✔',
  progress: undefined,
};

/** Symbols Re.Pack's own reporter prints; a leading one is recolored rather
 * than duplicated. */
const LEADING_SYMBOL = /^(\s*)([ℹ⚠✖✔✓√×✗])([\s\S]*)$/;

/** Re.Pack colors the level SYMBOL by level, whatever the heuristic kind
 * says — `✔ ...` reads green even when classification called it info. */
const SYMBOL_COLOR: Record<string, DevTuiColor> = {
  'ℹ': 'blue',
  '⚠': 'yellow',
  '✖': 'red',
  '✗': 'red',
  '×': 'red',
  '✔': 'green',
  '✓': 'green',
  '√': 'green',
};

export function symbolColor(symbol: string): DevTuiColor | undefined {
  return SYMBOL_COLOR[symbol];
}

export interface LeadingSymbol {
  indent: string;
  symbol: string | undefined;
  rest: string;
}

/** Split a leading level symbol (if any) so the renderer can color just the
 * glyph and leave the message plain (F5: colored symbol, plain message). */
export function splitLeadingSymbol(text: string): LeadingSymbol {
  const match = LEADING_SYMBOL.exec(text);
  if (match === null) {
    return { indent: '', symbol: undefined, rest: text };
  }
  return {
    indent: match[1] ?? '',
    symbol: match[2],
    // Trim the separator space; the renderer re-inserts exactly one so a
    // symbol never swallows or doubles the gap before the message.
    rest: (match[3] ?? '').replace(/^\s/, ''),
  };
}

/** F3 dot cycle: grow 1→6, shrink 5→2 — ten 100ms frames, then repeat. */
export const LIVE_DOT_CYCLE = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2];

/**
 * F3: replace the trailing dot run of a live spinner line with the animated
 * count for `frame`. Pure and render-only — the model keeps the child's real
 * last frame; this is the same cosmetic smoothing upstream Re.Pack's spinner
 * does in a terminal. Dotless text (bars, settled lines) is returned as-is.
 */
export function animateLiveDots(text: string, frame: number): string {
  const dots = /\.+$/.exec(text);
  if (dots === null) return text;
  const count = LIVE_DOT_CYCLE[Math.abs(frame) % LIVE_DOT_CYCLE.length];
  if (count === undefined) return text;
  return `${text.slice(0, dots.index) + '.'.repeat(count)}`;
}

/** Drop braille spinner glyphs (and one adjacent space) from a line (F4:
 * the dashboard shows the label/bar, not a duplicated animation glyph). */
export function stripSpinner(text: string): string {
  const stripped = text.replace(/[\s\u2800-\u28FF]*[\u2800-\u28FF][\s\u2800-\u28FF]*/g, ' ');
  return stripped === text ? text : stripped.trimStart();
}

// SGR mouse report: ESC [ < button ; col ; row M (press) | m (release).
// Ink strips the leading ESC, so both shapes are accepted. The ESC byte is
// built at runtime (no-control-regex forbids an ESC literal in a pattern).
const ESC = String.fromCharCode(0x1b);
const SGR_MOUSE = new RegExp(
  `${ESC}?\\[<(\\d+);(\\d+);(\\d+)([Mm])`,
  'g'
);
// Legacy X10 mouse report (never enabled by us; defensive strip).
const X10_MOUSE = new RegExp(`${ESC}\\[M[\\s\\S]{3}`, 'g');

export interface WheelEvent {
  dir: 'up' | 'down';
  col: number;
  row: number;
}

/**
 * F1: extract wheel notches from a raw `useInput` chunk. Only press events
 * count (SGR wheel sends button 64/65 press `M` then a +32 release `m`; the
 * release is skipped). A click (button 0) or drag is reported as mouse
 * traffic without being a wheel, so handlers can swallow it. Statelessness
 * over `input.matchAll` means chunks carrying MULTIPLE sequences parse fine.
 */
export function parseWheelEvents(input: string): WheelEvent[] {
  const events: WheelEvent[] = [];
  for (const match of input.matchAll(SGR_MOUSE)) {
    const button = Number.parseInt(match[1] ?? '', 10);
    const col = Number.parseInt(match[2] ?? '', 10);
    const row = Number.parseInt(match[3] ?? '', 10);
    const final = match[4];
    if (final !== 'M') continue; // release / motion terminators are not notches
    if (button === 64) events.push({ dir: 'up', col, row });
    else if (button === 65) events.push({ dir: 'down', col, row });
  }
  return events;
}

/** True when `input` carries ONLY mouse report traffic (SGR or X10): clicks,
 * drags and releases the dashboard deliberately ignores. */
export function isMouseOnlyInput(input: string): boolean {
  if (input === '') return false;
  const stripped = input.replace(SGR_MOUSE, '').replace(X10_MOUSE, '');
  return stripped === '';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DevTuiApp({
  model,
  onQuit,
  onOpenStudio,
  frame: frameProp,
}: DevTuiAppProps) {
  const { stdout } = useStdout();
  // The seam may run before the terminal reports a usable size (and the test
  // stdout has none): fall back to sane 4:3-ish defaults. ink re-renders on
  // `resize`, so real terminals recover on the next event.
  const columns = stdout.columns >= 40 ? stdout.columns : DEFAULT_COLUMNS;
  const rows = stdout.rows >= 8 ? stdout.rows : DEFAULT_ROWS;

  // The model changes on the seam's event callbacks, outside React. A fixed
  // tick re-renders the view; the same counter is the F3 animation frame.
  // Tests (and any caller wanting deterministic output) pin it via `frame`.
  const [frameState, setFrame] = useState(0);
  const frame = frameProp ?? frameState;
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((tick) => tick + 1);
    }, DEV_TUI_FRAME_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // F1: claim the wheel by asking the terminal for mouse reports (DECSET
  // 1000 + SGR 1006) for exactly as long as this component is mounted. Real
  // TTY only — writing the codes into a non-TTY stream (tests, pipes) would
  // leak escape bytes into captured output.
  useEffect(() => {
    if (stdout.isTTY !== true) return;
    stdout.write(MOUSE_TRACKING_ON);
    return () => {
      stdout.write(MOUSE_TRACKING_OFF);
    };
  }, [stdout]);

  // Scroll offset per app key, counted from the bottom. Absent entry = 0 =
  // autoscroll. Selection moves FORGET the new app's offset (per-app
  // autoscroll on select, per the task spec).
  const [scrolls, setScrolls] = useState<{ [key: string]: number }>({});

  const snap = model.snapshot();
  const selectedKey = snap.selectedKey;
  const selectedRow = snap.rows.find((row) => row.key === selectedKey);

  // F4: the active progress bar pins to the panel's last row; the rest flows
  // around it. `partitionPinned` unpins once the bar is no longer recent.
  const hiddenNoteHeight = snap.hiddenLines > 0 ? 1 : 0;
  const pageHeight = Math.max(1, rows - 1 - hiddenNoteHeight);
  const { pinned, body } = partitionPinned(snap.lines);
  const bodyPage = Math.max(1, pageHeight - (pinned === undefined ? 0 : 1));
  const storedOffset =
    selectedKey === undefined ? 0 : (scrolls[selectedKey] ?? 0);
  const window = logWindow(body.length, storedOffset, bodyPage);
  const shown = body.slice(window.start, window.end);

  const setScroll = (key: string | undefined, offset: number): void => {
    if (key === undefined) return;
    const next = Math.max(0, offset);
    setScrolls((prev) => {
      if (next === 0) {
        if (prev[key] === undefined) return prev;
        const { [key]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: next };
    });
  };

  const moveSelection = (move: (target: DevTuiModel) => void): void => {
    move(model);
    // Autoscroll per app on select: the newly selected app starts at bottom.
    const key = model.snapshot().selectedKey;
    if (key === undefined) return;
    setScrolls((prev) => {
      if (prev[key] === undefined) return prev;
      const { [key]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const halfPage = Math.max(1, Math.floor(pageHeight / 2));

  // Model mutations (selection) happen outside React state; re-render right
  // away so input feels instant instead of waiting for the next tick.
  const refresh = (): void => {
    setFrame((tick) => tick + 1);
  };

  useInput((input, key) => {
    refresh();
    // F1: wheel first — it must never fall through to selection keys. The
    // column decides the pane: sidebar rows move the selection by one, the
    // log panel scrolls by WHEEL_SCROLL_LINES. Other mouse traffic (clicks,
    // drags, releases) is swallowed, never interpreted as a key.
    const wheels = parseWheelEvents(input);
    if (wheels.length > 0) {
      for (const wheel of wheels) {
        if (wheel.col > SIDEBAR_WIDTH) {
          setScroll(
            selectedKey,
            storedOffset +
              (wheel.dir === 'up' ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES)
          );
        } else {
          moveSelection((target) =>
            wheel.dir === 'up' ? target.selectPrev() : target.selectNext()
          );
        }
      }
      return;
    }
    if (isMouseOnlyInput(input)) return;
    if (key.ctrl) {
      if (input === 'c') onQuit();
      return;
    }
    if (key.upArrow) {
      moveSelection((target) => target.selectPrev());
      return;
    }
    if (key.downArrow) {
      moveSelection((target) => target.selectNext());
      return;
    }
    if (key.pageUp) {
      setScroll(selectedKey, storedOffset + halfPage);
      return;
    }
    if (key.pageDown) {
      setScroll(selectedKey, storedOffset - halfPage);
      return;
    }
    if (key.end) {
      setScroll(selectedKey, 0);
      return;
    }
    if (key.tab) {
      // Cycle: clamped next, wrapping to first when already last.
      moveSelection((target) => {
        const before = target.selectedIndex();
        target.selectNext();
        if (target.selectedIndex() === before) target.selectFirst();
      });
      return;
    }
    switch (input) {
      case 'q':
        onQuit();
        return;
      case 'j':
        moveSelection((target) => target.selectNext());
        return;
      case 'k':
        moveSelection((target) => target.selectPrev());
        return;
      case 'g':
        setScroll(selectedKey, Math.max(0, body.length - bodyPage));
        return;
      case 'G':
        setScroll(selectedKey, 0);
        return;
      case 'v':
      case 'o':
        onOpenStudio?.();
        return;
      default:
        return;
    }
  });

  // Sidebar geometry: the box carries the divider (1 of SIDEBAR_WIDTH) as a
  // real border (F2) instead of a text `│` gutter, so a log-pane drag never
  // scoops up gutter glyphs from the panel side.
  const sidebarContentWidth = SIDEBAR_WIDTH - 1;
  const maxListRows = Math.max(0, rows - HELP_LINES);
  const listRows = snap.rows.slice(0, maxListRows);
  const panelContentWidth = Math.max(10, columns - SIDEBAR_WIDTH);
  const headerNameWidth = Math.max(
    4,
    panelContentWidth - 2 - 1 - (selectedRow?.portLabel?.length ?? 0)
  );

  return (
    <Box width={columns} height={rows}>
      <Box
        width={SIDEBAR_WIDTH}
        flexDirection="column"
        borderStyle="bold"
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        borderColor="gray"
        borderDimColor
      >
        {listRows.map((row, index) => {
          const selected = index === snap.selectedIndex;
          const port = row.portLabel ?? '';
          const nameWidth = Math.max(
            4,
            sidebarContentWidth - 3 - (port === '' ? 0 : port.length + 1)
          );
          return (
            <Box key={row.key}>
              <Text>{selected ? '▍' : ' '}</Text>
              <Text color={row.color}>{row.glyph}</Text>
              <Text>{' '}</Text>
              <Text
                {...(selected ? { bold: true, color: 'cyan' } : {})}
                wrap="truncate"
              >
                {truncate(row.name, nameWidth)}
              </Text>
              {port === '' ? null : <Text dimColor>{` ${port}`}</Text>}
            </Box>
          );
        })}
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
          <Text dimColor wrap="truncate">
            {truncate(HELP_KEYS, sidebarContentWidth)}
          </Text>
          <Text dimColor wrap="truncate">
            {truncate(HELP_WHEEL, sidebarContentWidth)}
          </Text>
          <Text dimColor wrap="truncate">
            {truncate(
              onOpenStudio === undefined ? 'q quit' : 'v studio · q quit',
              sidebarContentWidth
            )}
          </Text>
        </Box>
      </Box>

      <Box width={panelContentWidth} flexDirection="column">
        <Box>
          <Text bold wrap="truncate">
            {truncate(selectedRow?.name ?? '—', headerNameWidth)}
          </Text>
          {selectedRow === undefined ? null : (
            <Text color={selectedRow.color}>{` ${selectedRow.glyph}`}</Text>
          )}
          {selectedRow?.portLabel === undefined ? null : (
            <Text dimColor>{` :${selectedRow.portLabel}`}</Text>
          )}
        </Box>
        {snap.hiddenLines > 0 ? (
          <Text dimColor>{`… ${snap.hiddenLines} earlier lines hidden`}</Text>
        ) : null}
        {shown.map((line, index) => (
          <LogLine key={`${window.start + index}`} line={line} frame={frame} />
        ))}
        {shown.length === 0 && pinned === undefined ? (
          <Text dimColor>no output yet</Text>
        ) : null}
        {pinned === undefined ? null : (
          <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
            <LogLine line={pinned} frame={frame} />
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** One log row (F5 palette + F3/F4 progress cosmetics). */
function LogLine({ line, frame }: { line: DevTuiLine; frame: number }) {
  let text = line.text;
  if (line.kind === 'progress') {
    // F4: drop the child's spinner glyph and normalize bar graphics when the
    // printed percent already says 100 (never invents a completion).
    text = renderProgressFrame(stripSpinner(text));
    // F3: a still-updating spinner animates its dots on the shared tick.
    if (line.live === true) {
      text = animateLiveDots(text, frame);
    }
  }
  const { indent, symbol, rest } = splitLeadingSymbol(text);
  // stderr marker: yellow `!` (Re.Pack's warn color) only when the child
  // printed no level symbol of its own — `! ⚠ …` never doubles up.
  const marker = line.stream === 'stderr' && symbol === undefined;
  const glyph = symbol ?? (marker ? undefined : AUTO_GLYPH[line.kind]);
  const glyphColor =
    symbol !== undefined
      ? symbolColor(symbol)
      : glyph === undefined
        ? undefined
        : lineColor(line.kind);
  return (
    <Box>
      {marker ? <Text color="yellow">{'! '}</Text> : null}
      {indent === '' ? null : <Text>{indent}</Text>}
      {glyph === undefined ? null : (
        <Text {...(glyphColor === undefined ? {} : { color: glyphColor })}>
          {glyph}
        </Text>
      )}
      {glyph === undefined || rest === '' || /^\s/.test(rest) ? null : (
        <Text>{' '}</Text>
      )}
      <Text
        {...(line.live === true ? { dimColor: true } : {})}
        wrap="truncate"
      >
        {rest}
      </Text>
    </Box>
  );
}
