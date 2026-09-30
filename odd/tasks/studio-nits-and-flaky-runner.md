# studio layout follow-ups and the flaky dev runner suite

## Objective

Close the small Studio layout follow-ups (#12) and make the dev runner
spawned-stub suite deterministic (#19).

## Tasks

- [ ] T1 (#12) name the label nudge constants, single-source the overlap
      logic, test the least-overlap fallback, explicit `rect.elabel-bg`
      selector, Native tab version cells do not wrap (e2e). Route: delegated
      direct.
- [ ] T2 (#19) first test waits for the `mini_auth` error transition over SSE
      with a bounded timeout; each test starts from released ports even after
      a failure; 20 consecutive local runs pass. Route: delegated direct.

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e`

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `fix/studio-nits-and-flaky-runner` from `9ddc23e`.
