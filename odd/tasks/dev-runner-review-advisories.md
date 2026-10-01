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

- [x] T1 Runtime advisories A1–A5 (one commit: refactor/fix with tests). Commit 8ed8d38.
- [x] T2 Test and prompt advisories A6–A9 (one commit). Commit 4d0ebfd.

Route: delegated direct, one writer (2+ non-trivial files).

## Outcomes

All nine advisories still applied on the current code; none was resolved by #38/#40.

- A1 fixed in 8ed8d38: `DevPlanEntry.declaredPort` now only means "what the plan asked for" (`null` = auto); `applyAssignments` records the result in the new `allocatedPort`; `toPlanEventApps` projects `allocatedPort ?? declaredPort` into the unchanged `port` field.
- A2 fixed in 8ed8d38: `OneShotEvent` gained a typed `spawn-failed` member; the `spawn-error` signal string is confined to the process-runner port and to the `--json` launch event, which keeps emitting it for compatibility.
- A3 fixed in 8ed8d38: `spawnOneShot` contains a throwing `onOneShot` hook at every call and a rejecting `waitForExit`; tests in `tests/runner/supervisor.test.ts`.
- A4 fixed in 8ed8d38 and corrected in the follow-up `fix(dev): detect an unreadable app root through the ProjectFs contract`: the first version relied on `readdir` throwing, but `ProjectFs` returns `[]`/`null` instead, so it never fired. The toolchain now `stat`s the app root; when it is missing or not a directory (and `config` does not decide the bundler) it sets `bundlerNote`, the plan returns it as `warnings`, and the CLI prints `dev: warning  <app>: ...` on stderr. A missing root with no resolvable react-native CLI still exits 2 first.
- A5 fixed in 8ed8d38: there was no `--platform` value check in `loadDevPlan`; the duplicate was the `--launch needs a single platform` guard. Both now use `LAUNCH_NEEDS_PLATFORM_REASON` (guard kept for non-CLI callers).
- A6 fixed in 4d0ebfd: the test moved to `tests/runner/toolchain.test.ts`.
- A7 fixed in 4d0ebfd (behavior change, `fix`): only an option whose `value` is `none` suppresses the readline `none` keyword; a label alone no longer does. `emptyHint` comment and the `atlas-runner` skill updated.
- A8 fixed in 4d0ebfd: the host-only wizard test is split into three tests, one behavior each.
- A9 fixed in 4d0ebfd: runner tests run on a temp copy of `fixtures/workspace` with free remote ports; the fixture is untouched.

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
- T1 and T2 done; full checks green after each commit.

## Next step

Open the PR to main (owner pattern: PR, gga, merge).
