# review follow-ups from PRs #21-#24

## Objective

Close the advisory findings native reviews raised on PRs #21, #22, #23 and
#24: init discovery edge cases (#8), introspection shared-entry coverage
(#10), runner test error handling (#19) and Studio test guards (#12, #11).

## Tasks

- [x] T1 (#8) init: apply `!` exclusions in the `apps/*` fallback; guarantee
      unique dashed names (`-2`, `-3`); warn in text and `--json` when the `**`
      depth cap truncates a walk; test `ios`/`android`/`Pods` pruned under a
      non-app dir. Route: delegated direct.
- [x] T2 (#10) introspection: test `singleton`, `eager`, `requiredVersion`
      survive on Atlas-shaped array entries and `packageName` version
      resolution still works. Route: delegated direct.
- [x] T3 (#19) runner test: `reap` throws an `AggregateError` when more than
      one kill fails; `killGroup` gets an explicit `Error | undefined` return
      type. Route: delegated direct.
- [x] T4 (#12, #11) studio tests: least-overlap fallback guard derived from
      the geometry it builds; e2e assertion that the `standalone` badge sits
      left of the status dot without overlapping. Route: delegated direct.

- [x] T5 (#10) docs/demo-showcase.md refreshed for atlas-demo: 6 commits,
      `getSharedDependencies({ eager })` note, corrupt-step summary, init
      dry-run parity note. Route: inline (single doc).

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`,
5 consecutive runs of `pnpm exec tsx --test tests/runner/dev-runner.test.ts`,
`node scripts/commit-check.mjs --range main..HEAD`.

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `fix/review-followups` from `9e0afc7`.
- T1 `88fece9`: exclusions shared by both discovery paths; `assignDirNames`
  keeps plain basenames, then dashed names in sorted dir order with `-2`,
  `-3`; `InitPlan.warnings` surfaces the depth-cap truncation in text and
  `--json` (new `warnings` array).
- T2 `2fa3859`: array-entry flags and `packageName` resolution tests.
- T3 `d7b5dff`: `AggregateError` for 2+ kill failures, `killGroup` typed
  `Error | undefined`.
- T4 `b9488e9`: fallback guard derived from the built geometry; e2e bounding
  boxes for badge vs status dot.
- T5 `8996b11`: runbook facts supplied by the coordinator from atlas-demo.
- Evidence: build, typecheck, lint ok; `pnpm test` 343/343; `pnpm test:e2e`
  12 passed; runner suite 5/5 consecutive runs (6 pass each);
  `commit-check --range main..HEAD` ok.

## Orphan-kill review follow-ups (2026-10-02, lineage review-ec139f207a433c42)

Approved review of `feat/dev-port-ux` (e776221..e4835f0) left two
non-blocking items — separate later work, never a reason to re-review:

- WARNING `R3-partial-kill-stale-error` (src/runner/orphan.ts:105-116):
  when several orphans are killed but one port never frees within
  `waitFreeTimeoutMs`, the earlier kill notes are dropped and the stale
  "port X is already busy" lines print for ports already freed. The next
  run works; the one-time message misleads. Fix shape: report the killed
  notes even when landing on `unavailable`.
- SUGGESTION `R3-runcommand-subscribe-no-guard` (src/adapters/port-owner.ts:
  54-57): `subscribeToStdout` runs outside the try/catch around
  `runner.start`; a throwing handle resolves only via the 2s timeout. Move
  the subscribe inside the guard.
