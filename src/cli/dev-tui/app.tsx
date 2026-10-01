// Ink dashboard for interactive `dev` sessions
// (odd/tasks/dev-tui-dashboard.md T3). PURE rendering layer: it receives the
// pure `DevTuiModel` (T2) plus control callbacks and renders a sidebar (apps
// + status glyphs + ports) and a log panel for the selected row. It imports
// NO supervisor, fs or process logic, and it never touches stdout itself —
// which is why the rest of `src/cli` stays ink-free: the machine paths
// (`--json`, `--ci`, non-TTY) must never import ink/react (AGENTS.md rule 11),
// so the T4 seam dynamic-imports exactly this module once a session is
// human-interactive. Quit (`q`, Ctrl-C) and Studio (`v`, `o`) are callbacks
// only — shutdown sequencing, alt-screen and raw-mode ownership stay in
// `dev.ts`. The model is mutable and event-fed, so the component re-reads
// `model.snapshot()` on a small fixed tick instead of pushing renders from
// the event source. Requires ink `render(..., { exitOnCtrlC: false })` so
// Ctrl-C reaches `onQuit` instead of ink killing the process.

import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useState } from 'react';
import {
  type DevTuiColor,
  type DevTuiModel,
  type LineKind,
} from './model.js';

/** Sidebar column width, including its right border (layout contract). */
export const SIDEBAR_WIDTH = 24;

/** How often the view re-reads the model (ms). Input re-renders on its own. */
export const DEV_TUI_FRAME_MS = 100;

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const HELP_LINES = 2;
const HELP_SCROLL = '↑↓ select · PgUp/PgDn scroll';

export interface DevTuiAppProps {
  /** Pure view-model the seam feeds with log/status/oneShot events. */
  model: DevTuiModel;
  /** `q` / Ctrl-C. The seam owns shutdown; this component never exits. */
  onQuit: () => void;
  /** `v` / `o`. Pass only when the session has a Studio; hides the hint. */
  onOpenStudio?: () => void;
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

/** Log-line kind → ink color token; `info` stays the default foreground. */
export function lineColor(kind: LineKind): DevTuiColor | undefined {
  switch (kind) {
    case 'success':
      return 'green';
    case 'warn':
      return 'yellow';
    case 'error':
      return 'red';
    case 'progress':
      return 'cyan';
    case 'info':
      return undefined;
  }
}

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DevTuiApp({ model, onQuit, onOpenStudio }: DevTuiAppProps) {
  const { stdout } = useStdout();
  // The seam may run before the terminal reports a usable size (and the test
  // stdout has none): fall back to sane 4:3-ish defaults. ink re-renders on
  // `resize`, so real terminals recover on the next event.
  const columns = stdout.columns >= 40 ? stdout.columns : DEFAULT_COLUMNS;
  const rows = stdout.rows >= 8 ? stdout.rows : DEFAULT_ROWS;

  // The model changes on the seam's event callbacks, outside React. A fixed
  // tick re-renders the view; input-triggered changes refresh within one tick.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
    }, DEV_TUI_FRAME_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // Scroll offset per app key, counted from the bottom. Absent entry = 0 =
  // autoscroll. Selection moves FORGET the new app's offset (per-app
  // autoscroll on select, per the task spec).
  const [scrolls, setScrolls] = useState<{ [key: string]: number }>({});

  const snap = model.snapshot();
  const selectedKey = snap.selectedKey;
  const selectedRow = snap.rows.find((row) => row.key === selectedKey);

  const hiddenNoteHeight = snap.hiddenLines > 0 ? 1 : 0;
  const pageHeight = Math.max(1, rows - 1 - hiddenNoteHeight);
  const total = snap.lines.length;
  const storedOffset =
    selectedKey === undefined ? 0 : (scrolls[selectedKey] ?? 0);
  const window = logWindow(total, storedOffset, pageHeight);
  const shown = snap.lines.slice(window.start, window.end);

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
    setTick((tick) => tick + 1);
  };

  useInput((input, key) => {
    refresh();
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
        setScroll(selectedKey, Math.max(0, total - pageHeight));
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

  // Sidebar geometry: the box carries a right border (1 of SIDEBAR_WIDTH).
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
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        borderColor="gray"
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
              <Text inverse={selected} wrap="truncate">
                {truncate(row.name, nameWidth)}
              </Text>
              {port === '' ? null : <Text dimColor>{` ${port}`}</Text>}
            </Box>
          );
        })}
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
          <Text dimColor wrap="truncate">
            {truncate(HELP_SCROLL, sidebarContentWidth)}
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
        {shown.map((line, index) => {
          const color = lineColor(line.kind);
          return (
            <Box key={`${window.start + index}`}>
              {line.stream === 'stderr' ? (
                <Text color="red" dimColor>
                  {'! '}
                </Text>
              ) : null}
              <Text
                {...(color === undefined ? {} : { color })}
                {...(line.live === true ? { inverse: true } : {})}
                wrap="truncate"
              >
                {line.text}
              </Text>
            </Box>
          );
        })}
        {shown.length === 0 ? <Text dimColor>no output yet</Text> : null}
      </Box>
    </Box>
  );
}
