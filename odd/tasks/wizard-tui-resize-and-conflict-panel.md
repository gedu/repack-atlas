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
- Pending: manual real-terminal check of shrink/grow ghosts and of the
  conflict panel (terminal reflow is emulator behavior; the dev.ts TTY branch
  is gated on `process.stdin.isTTY`, not injectable in tests).

## Next step

Manual PTY check, then work-unit commit(s).
