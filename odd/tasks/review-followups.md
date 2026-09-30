# review follow-ups from PRs #21-#24

## Objective

Close the advisory findings native reviews raised on PRs #21, #22, #23 and
#24: init discovery edge cases (#8), introspection shared-entry coverage
(#10), runner test error handling (#19) and Studio test guards (#12, #11).

## Tasks

- [ ] T1 (#8) init: apply `!` exclusions in the `apps/*` fallback; guarantee
      unique dashed names (`-2`, `-3`); warn in text and `--json` when the `**`
      depth cap truncates a walk; test `ios`/`android`/`Pods` pruned under a
      non-app dir. Route: delegated direct.
- [ ] T2 (#10) introspection: test `singleton`, `eager`, `requiredVersion`
      survive on Atlas-shaped array entries and `packageName` version
      resolution still works. Route: delegated direct.
- [ ] T3 (#19) runner test: `reap` throws an `AggregateError` when more than
      one kill fails; `killGroup` gets an explicit `Error | undefined` return
      type. Route: delegated direct.
- [ ] T4 (#12, #11) studio tests: least-overlap fallback guard derived from
      the geometry it builds; e2e assertion that the `standalone` badge sits
      left of the status dot without overlapping. Route: delegated direct.

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`,
5 consecutive runs of `pnpm exec tsx --test tests/runner/dev-runner.test.ts`,
`node scripts/commit-check.mjs --range main..HEAD`.

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `fix/review-followups` from `9e0afc7`.
