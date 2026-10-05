# Wizard TUI: last recap, resize ghosts, conflict panel

## Objective

Polish the ink dev wizard (`src/cli/dev-tui/wizard.tsx`) after the recap
panel landed (#65): every answered question ends inside the panel, resizing
the terminal leaves no ghost frames, and the busy-port lines that follow a
wizard read as one soft-yellow panel.

## Problem

1. Resizing the terminal (shrink, then grow) leaves stacked copies of the
   panel's top border above the live frame.
2. The `dev: port … is already busy` lines printed after the wizard are bare
   lines under the framed recap.
3. The last answered question is missing from the panel: the standing frame
   still shows it live.

## Root causes (observed)

- T1 (item 3): `settle()` emits, React queues the commit in a microtask, and
  the wizard's `await` resumes into `close()` first; `unmount()` then flushes
  a frame that predates the last answer. Reproduced with a fake TTY stdout:
  confirm → `y` → close leaves `● Q2 last?` live and no `✓ Q2` recap.
- T2 (item 1): on a width decrease ink erases only the rows it wrote; the
  terminal has already re-wrapped lines wider than the new width, so the top
  rows of the old frame survive above the new one.

## Scope

- `src/cli/dev-tui/wizard.tsx` (+ a pure reflow helper)
- `src/cli/dev.ts` port-conflict reporting on the human TTY path only
- tests under `tests/cli/`

Machine paths (`--json`, `--ci`, non-TTY) keep their conflict lines byte for
byte.

## Tasks

- [x] T1 Flush the last answer before unmount (sync `rerender` in `close()`),
      with a regression test. Route: inline (one file, cause proven).
- [x] T2 Reflow compensation on terminal shrink: delete the re-wrapped rows
      ink cannot see, pure row math unit-tested. Route: delegated writer.
- [x] T3 Port-conflict lines in a dim-yellow rounded panel on the human TTY
      path; plain lines elsewhere. Route: delegated writer.
- [x] T4 Review advisories: (A) CI-detection drift guard, (B) conflict panel
      also gated on `stderr.isTTY`, (C) one NO_COLOR helper per no-color.org,
      (D) NaN/0/Infinity guard in the reflow math. Route: delegated writer
      (5 source/test files).
- [x] T5 Review round 3 (approved, non-blocking): R3-001 compensate only on
      terminals known to reflow; R3-002 validate `stdout.columns` and delete
      for the smaller of the last two committed frames; R3-003 machine-path
      lock for bare conflict lines. Principle: when unsure, leave a ghost
      border rather than delete real rows. Route: delegated writer (3 test
      files + 2 source files).
- [x] T6 Fixed-height recap panel: answered lines truncate (`…`) instead of
      wrapping, so a shrink never grows the frame past the screen (rows that
      scroll into scrollback cannot be erased: the stacked panels seen on a
      very small window). The live question still wraps. Route: inline (one
      source file + one test).
- [x] T7 Banner sizes by width: full art >= BANNER_MIN_COLUMNS, wordmark +
      tagline below it, nothing when even the tagline does not fit. Printed
      once, so a later resize still reflows it (out of scope: moving it into
      the live frame). Route: inline (banner.ts + its test).

## Checks

`pnpm build && pnpm lint && pnpm typecheck && pnpm test`; manual PTY check of
resize and of the conflict panel (cannot be automated: reflow is the terminal
emulator's behavior).

## Progress

- T1 done: regression test `holds the last answer in the panel when close()
  follows the answer at once` (tests/cli/dev-tui-wizard-port.test.ts). RED
  with the `rerender` line removed (CI unset and CI=1: 1 fail), GREEN with it.
  Note: `CI=` (empty) still counts as CI mode for ink's is-in-ci; local
  non-CI runs need `env -u CI`.
- T2 done: `src/cli/dev-tui/reflow.ts` (`reflowedRows`, `reflowCompensation`)
  + 12 unit tests (RED: module missing). `wizard.tsx` split into pure
  `WizardView` + hooked `WizardApp`; a `resize` listener prepended before
  ink's writes the compensation on a shrink (TTY, non-CI only) and is removed
  in `close()`. Port test RED (compensation index -1) then GREEN. Verified
  ink's live frame chunk equals `renderToString(<WizardView/>) + '\n'` (both
  color modes), so F = frame lines and the cursor row is the one below.
- T3 done: `src/cli/dev-tui/conflict-panel.ts` (`renderConflictPanel`, dim
  yellow `2;33` border, NO_COLOR plain, width capped, word-wrapped) + 6 unit
  tests (RED: module missing). `dev.ts` prints it only when `tuiCondition &&
  plan.portConflict`; all other paths unchanged.
- Checks: `pnpm build` ok, `pnpm lint` ok, `pnpm typecheck` ok, `pnpm test`
  823/823 (CI unset and CI=1), dry-run smoke exit 0.
- T4 done:
  - A: `isInkCiMode(env)` exported from `wizard.tsx` (module constant now
    computed from it; the port test uses it too).
    `tests/cli/dev-tui-ci-parity.test.ts` resolves the `is-in-ci` ink itself
    depends on (`createRequire(require.resolve('ink'))`) and compares its
    verdict in a clean-env child for 9 envs (none, CI=1/''/0/false,
    CONTINUOUS_INTEGRATION=true/false, CI_SERVER, GITLAB_CI). No dependency
    added.
  - B: `shouldFramePortConflict` + `formatPlanFailure` in `conflict-panel.ts`
    (pure); `dev.ts` frames only when `tuiCondition && portConflict &&
    process.stderr.isTTY === true`. Unframed output is byte-identical to the
    old `dev: ${reason}` lines (unit-tested).
  - C: `colorAllowed(env)` in `banner.ts` (`NO_COLOR` unset or empty allows
    color), used by the banner and conflict panel in `dev.ts` and by the
    wizard.
  - D: `reflowCompensation` returns `''` for a non-finite or <= 0
    `newColumns`/`screenRows`; `reflowedRows` counts one row per line for an
    unusable width.
  - RED: the three new suites failed to load (`does not provide an export
    named colorAllowed / isInkCiMode / formatPlanFailure`); reflow 3/15
    failed (`'\r\x1B[NaNA\x1B[NaNM\x1B[1B' !== ''`, `NaN !== 2`). GREEN:
    targeted suites 80/80.
  - Checks: `pnpm build`, `pnpm lint`, `pnpm typecheck` ok; `pnpm test`
    844/844 with CI unset and CI=1; dry-run smoke exit 0.
- T5 done:
  - R3-001: `terminalReflowsOnResize(env)` in `reflow.ts`, a conservative
    allowlist (TERM_PROGRAM iTerm.app/Apple_Terminal/ghostty/WezTerm/vscode/
    Tabby/Hyper/tmux; TERM xterm-kitty/xterm-ghostty/alacritty/wezterm;
    KITTY_WINDOW_ID/WEZTERM_PANE/GHOSTTY_RESOURCES_DIR). tmux included (it
    owns the pane grid and reflows it on resize; >= 3.2 exports
    TERM_PROGRAM=tmux); a GNU screen session (`STY`) is excluded even with
    inherited markers. `createTuiPromptPort` gains `reflowsOnResize`
    (default from `process.env`); the listener installs only when it holds.
  - R3-002: the handler ignores a non-finite / <= 0 `stdout.columns` and
    keeps the last good width; `WizardApp` reports each committed state via
    `onCommit` (`useLayoutEffect`), the port keeps the last two, and
    `safestReflowCompensation` deletes for the frame with FEWER extra rows.
  - R3-003: `tests/runner/dev-runner.test.ts` "a busy port prints bare
    conflict lines on the machine paths" (`--no-interactive --no-studio`,
    `--json --no-studio`, `--dry-run --no-interactive`, stdio piped): exact
    conflict + hint lines, no box glyphs, no ESC, exit 1.
  - RED: reflow suite failed to load (missing exports); port "resize guards"
    4/4 failed (`a ghost border beats deleting rows…`, `a valid shrink after
    invalid readings still compensates`, `deleted 10 rows; the smaller frame
    wrapped only 3 extra` x2). R3-003 is a lock, green on arrival; mutation
    check (`framed: true` forced in dev.ts) turned it RED, then reverted.
  - Checks: `pnpm build`, `pnpm lint`, `pnpm typecheck` ok; `pnpm test`
    881/881 with CI unset and CI=1; dry-run smoke exit 0.
- T6 done: `WizardLineView` texts use `wrap="truncate-end"`. Test `keeps
  the recap panel one row per answer however narrow the terminal gets`
  (dev-tui-wizard-app) RED at columns=30 (panel wrapped), GREEN after.
- T7 done: `renderStartupBanner` returns the wordmark + tagline below
  BANNER_MIN_COLUMNS and `''` below the text width. Banner suite RED 2/12
  without the source change, GREEN 12/12.
- Checks (T6+T7): `pnpm build`, `pnpm lint`, `pnpm typecheck` ok; `pnpm
  test` 883/883 with CI unset and CI=1.
- Manual PTY check of T1-T5 by the user: the conflict panel and the
  normal shrink/grow look right; a very small window stacked panels (fixed
  by T6, recheck pending).
- Pending: manual real-terminal check of shrink/grow ghosts and of the
  conflict panel (terminal reflow is emulator behavior; the dev.ts TTY branch
  is gated on `process.stdin.isTTY`, not injectable in tests).

## Next step

Manual PTY check, then work-unit commit(s).
