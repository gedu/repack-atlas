# Dev runner: close the leftover review advisories

## Objective

Close the non-blocking advisories the native reviews and gga left on the dev
runner (PRs #36, #38, #40), so no known weak spot stays open.

## Scope (verify each still applies before changing it)

- A1 `declaredPort` mixes three meanings: declared, allocated and `null` (auto)
  (`src/runner/plan.ts`).
- A2 Spawn errors are a sentinel value rather than a typed result
  (`src/runner/supervisor.ts`).
- A3 The one-shot (launch) exit chain is unguarded (`src/runner/supervisor.ts`).
- A4 Toolchain resolution falls back silently (`src/runner/toolchain.ts`).
- A5 The `--platform` gate in `loadDevPlan` duplicates the CLI check
  (`src/runner/supervisor.ts`).
- A6 A toolchain test lives in `tests/runner/launch-plan.test.ts`.
- A7 An option *labelled* "None" silently disables the readline `none`
  keyword (`src/adapters/prompts-readline.ts`, from #40).
- A8 Host-only wizard test structure (`tests/cli/dev-wizard.test.ts`, #40).
- A9 Runner tests rely on fixture ports 8082/8083 being free (flake risk,
  `tests/runner/dev-runner.test.ts`).

Out of scope: the `dev.ts:250-256` advisory (its target no longer resolves
after line shifts; not guessed); Windows-only shim tests (no Windows CI).
Behavior and `--json` contract stay unchanged unless an advisory is a real bug.

## Tasks

- [ ] T1 Runtime advisories A1–A5 (one commit: refactor/fix with tests).
- [ ] T2 Test and prompt advisories A6–A9 (one commit).

Route: delegated direct, one writer (2+ non-trivial files).

## Checks

`pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm agent:check &&
pnpm check:vendored`, `pnpm check:commits --range main..HEAD`; showcase
dry-run argv unchanged.

## TDD

Mode: off. Runner: `pnpm test`.

## Delivery

Single PR to main (owner pattern: PR, gga, merge).

## Progress

- Branch `fix/review-advisories` from main `4596181`.

## Next step

T1.
