# Wizard recap panel + readable owner commands (D2 of #58 follow-up work)

## Objective

The ink wizard's settled recap block ("✓ Use port 8081 for host? (in use: node
/Users/…/cli.js start) yes") runs flush against the `dev:` error lines that
follow it and wraps ugly: the long `(in use: …)` owner command eats the whole
line. Two presentation fixes, user-prioritized 2026-10-02 ("lo principal es el
recuadro de summary"):

- **P1 — recap panel**: put the settled recap/summary lines in a subtle box
  with clear vertical separation from the live question and from what follows
  (box preferred over bare indentation).
- **P2 — middle-elision formatter**: trim the owner command from the MIDDLE so
  the distinguishing tail survives (`~/…/super-app-showcase/packages/host/
  node_modules/…/cli.js start`), prefer shortening `$HOME` to `~` and dropping
  a redundant leading `node `. Keep the 100-char cap.

D1 (live-sibling port-choice select) is explicitly out of scope for this
branch by user decision — separate work unit.

## Problem / why

Real dual-terminal smoke (issue #58): the wizard warns "(in use: …)", the user
answers yes, and the run dies on generic conflict lines printed with zero
separation from the recap. The recap also loses the only part of the owner
command that identifies WHICH session holds the port — its tail — because the
current formatter elides from the end.

## Scope

- `src/cli/dev-tui/wizard.tsx` (+ `wizard-model.ts` if line shaping needs it):
  the settled-lines block becomes an indented/boxed panel; one blank line of
  separation minimum; panel stays on screen after the wizard closes (so the
  following `dev:` lines are visually separated from it).
- `src/runner/ports.ts::formatOwnerCommand`: middle-elision + `$HOME`→`~` +
  optional leading-`node ` drop, cap semantics preserved (result never exceeds
  `maxLength`; existing callers keep their contract).
- Human TUI + human clack/readline paths only. `--json`/`--ci` bytes untouched.
- No new runtime deps (rule 11), no core boundary crossings (rule 2), exit
  codes 0/1/2 untouched (rule 6).

## Measured facts this design rests on (ink 6.8.0, fake non-TTY stdout)

- A plain `Box` with a border SURVIVES `unmount()` on screen exactly like
  `<Static>` does: ink's unmount flushes the final frame and `log.clear()`
  only ever clears the previous frame. So the recap block may become a live
  (non-Static) panel without its content vanishing when the wizard closes.
- Long text inside a bordered Box wraps and RE-FLOWS at any terminal width
  (100 and 60 cols probed) without breaking the border.
- ink trims a single trailing blank `Text` line at end of output; a spacer
  before the live question renders.

## Tasks

- [x] WU1 — P2: `formatOwnerCommand` middle-elision (`head…tail`),
      `$HOME`→`~`, leading-`node ` dropped only when the rest still exceeds
      the cap; cap contract (≤ maxLength, `…` marker) kept. Formatter tests
      next to the existing ones; orphan `killQuestion` cap test updated for
      the new ellipsis marker only.
      Route: inline direct (two files, one function).
- [x] WU2 — P1: the settled recap/summary lines render inside a dim
      rounded panel (dashboard's `borderStyle="bold"`/gray-dim idiom, rounded
      corners), with one blank line between the panel and the live question,
      and the panel kept on screen after close so the following `dev:` lines
      separate. Content identical with color off.
      Route: inline direct (render layer, one file + its view tests).

## Checks

```
pnpm build && pnpm typecheck && pnpm lint
CI=true pnpm test          # ink CI-mode: live frames skipped on fake TTY
pnpm test
```

Baseline to beat/keep: the #60 baseline the coordinator recorded (794 tests).

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`. Behavior is
presentation; formatter tests observe RED first for WU1 (the middle-elision
assertions fail against the end-elision implementation), and WU2's panel/blank
line assertions are new frame assertions that fail before the change.

## Progress

- Branch `feat/live-session-port-choice` from `d7fe4bc` (= origin/main after
  #59, #60, #63). Worktree
  `../repack-atlas-worktrees/live-session-port-choice`.
- WU1 `3beb43f`; WU2 `82d1393`. No push, no PR (user rule).
- `<Static>` replaced by a live bordered Box: measurement (ink 6.8, fake
  non-TTY stdout) shows ink's teardown leaves the final frame standing, so the
  panel survives close exactly as Static's output did. Frame assertions that
  depend on a LIVE frame write are gated on ink's own `is-in-ci` predicate in
  `dev-tui-wizard-port.test.ts` (CI mode skips per-frame writes and, on
  unmount, writes only `lastOutput + '\n'`, which ink never sets in debug
  mode); content coverage stays in the ink-testing-library suite.
- Evidence: `CI=true pnpm test` 803 pass / 0 fail and `pnpm test` 803 pass /
  0 fail (baseline after #60 was 794; +9 new tests).
- Real-terminal look of the panel stays user-owned (ink-testing frames are the
  automated evidence).
