# studio layout follow-ups and the flaky dev runner suite

## Objective

Close the small Studio layout follow-ups (#12) and make the dev runner
spawned-stub suite deterministic (#19).

## Tasks

- [x] T1 (#12) name the label nudge constants, single-source the overlap
      logic, test the least-overlap fallback, explicit `rect.elabel-bg`
      selector, Native tab version cells do not wrap (e2e). Route: delegated
      direct.
- [x] T2 (#19) first test waits for the `mini_auth` error transition over SSE
      with a bounded timeout; each test starts from released ports even after
      a failure; 20 consecutive local runs pass. Route: delegated direct.

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `fix/studio-nits-and-flaky-runner` from `9ddc23e`, rebased on `7be4959`.
- T1 `99e31ab`: `LABEL_NUDGE_STEPS`/`LABEL_NUDGE_PX` named, unused
  `overlaps` removed (`overlapArea` is the single helper), least-overlap
  fallback unit test, `rect.elabel-bg` selector, Native version cells nowrap
  with e2e (fails with nowrap off, passes with it on).
- T2 `dd34667`: first test polls SSE frames until `mini_auth` reports
  `error` (10s bound); `beforeEach`/`afterEach` kill leaked process groups and
  wait for 8082/8083 to be free. Ports are confirmed released, not freshly
  allocated (the fixture pins them). No runner production change.
- Evidence: writer 20/20 runs of the runner suite, `pnpm test:e2e` 12 passed;
  parent after rebase `pnpm test` 339/339 and 3/3 runner suite runs. The
  original CI flake could not be reproduced locally.
