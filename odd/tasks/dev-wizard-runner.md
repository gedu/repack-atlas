# Interactive dev runner (wizard, platforms, launch)

## Objective

Bring `repack-atlas dev` to parity with the interactive federation dev runner
of callstack/repack PR #1467: a wizard that picks remotes, platform, ports and
standalone mode, equal non-interactive flags, dry-run, and app launch on the
device. Update PRD, README and the demo runbook to match.

## Problem

PRD §7.1 (`docs/PRD.md:265`) promises "pick remotes, platforms, ports" with
equal non-interactive flags. T9 shipped a demo-grade runner ("no wizard, no
platforms, no launch", `src/cli/dev.ts:1-5`) with no recorded decision. The
demo runbook works around it with `pnpm --filter <app> start`. The wizard was
part of the plan and must exist.

## Decisions (owner, 2026-09-30)

- Atlas builds each app's argv by default, like upstream:
  `node <app rn cli> start --bundler <detected> [--config <path>] --port N
  --no-interactive [--platform p] [--standalone]`, resolved from each app's
  own root (no cross-app fallback). A config `command` is an explicit override
  run verbatim; it receives platform/standalone only as env vars
  (`ATLAS_APP_PLATFORM`, `ATLAS_APP_STANDALONE`). `init` stops emitting
  `command`.
- Wizard prompts use `@clack/prompts` (first runtime dependency) loaded by
  dynamic import behind a `PromptPort`, with a readline fallback. AGENTS.md's
  no-runtime-deps rule is updated to name this exception.
- Defaults aligned with upstream: host port precedence `--port` > host `port`
  > 8081; `--auto-ports` reassigns busy declared ports, otherwise a conflict is
  exit 1; `--ci` stays as an alias that implies `--no-interactive`; dry-run
  spawns nothing and does not bind Studio; `--launch` without a single
  platform is exit 2; a failed launch never fails the session.
- Wizard gate: runs only when `--apps` is absent, not `--no-interactive`/`--ci`/
  `--json`, and stdout is a TTY. Cancel exits 0 with nothing spawned. Wizard
  answers build the same plan input as flags (one execution path).
- Existing `--json` events (`studio`, `app`, `exit`) stay; `plan` is additive.
- Deferred: `/status` HTTP readiness, `d` debugger key, adb reverse, status
  block console. TCP readiness probe stays.

## Tasks

- [x] T1 Pure plan + `--dry-run`: extract a pure `buildDevPlan`, add
      `{event:'plan'}` (additive), human plan table, no spawn, no Studio.
- [x] T2 Ports: `--port` host override, default 8081, `--auto-ports`, all
      conflicts reported (exit 1).
- [x] T3 Default argv: config `config` field, RN CLI resolver adapter
      (`createRequire` from app root), `detectBundler`, `command` as override;
      `init` stops emitting `command`.
- [x] T4 `--platform ios|android`, `--standalone <remote>` (gated on
      `standalone: true`), env contract for `command` apps.
- [x] T5 Launch: `--launch/--no-launch/--device`, one-shot
      `run-<platform> --no-packager` on the target's first ready, `[launch]`
      prefix, exactly once, killed on shutdown.
- [x] T6 Wizard: `PromptPort`, clack via dynamic import, readline fallback;
      steps remotes → platform → launch → ports → standalone; gate and cancel.
- [x] T7 Docs: PRD §7.1 and related lines, README dev section, demo runbook
      (wizard instead of `pnpm --filter`), DEV_HELP, AGENTS.md dependency rule,
      `atlas-runner` skill referenced at PRD:416 + `pnpm agent:sync`.

Route per task: delegated direct (single writer; each task touches 2+
non-trivial files).

## Checks

`pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm agent:check &&
pnpm check:vendored`, `node scripts/commit-check.mjs --range main..HEAD`.

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`
(`tsx --test "tests/**/*.test.ts"`).

## Delivery

Strategy: ask-on-risk → chain strategy `feature-branch-chain` (owner,
2026-09-30). Forecast well above 400 authored lines. Base branch
`feat/dev-wizard-runner`; one slice branch + PR per task into it; the feature
branch merges to main once at the end.

## Progress

- Branch `feat/dev-wizard-runner` created. Gap analysis vs PR #1467 done.
- T1 done on `feat/dev-wizard-runner-t1`, commit `6f74c15`
  (`feat(dev): add pure plan builder and --dry-run`), 695 authored lines
  (over the advisory; mostly tests + new `src/runner/plan.ts`). Route:
  delegated direct. Checks: full chain green, 374/374 tests; parent spot
  check re-ran plan + dev-runner tests (18/18). Native review: high risk,
  granted, 4 lenses, approved with no blockers, acknowledged.
- T1 advisory findings carried into T2: unify busy-port exit code (dry-run 1
  vs live 2 → 1, upstream parity); duplicated ref resolution in
  `supervisor.ts:130-132`; misleading shared-probe comment
  `supervisor.ts:158-159`; exit-code wording in `help.ts:143-144`; dry-run
  `--json` test depends on a free host port (`dev-runner.test.ts:524-544`);
  busy probe is loopback-only in tests.

- T2 done on `feat/dev-wizard-runner-t2`, commit `0e8837b`
  (`feat(dev): add --port and --auto-ports with unified conflict exit`), 835
  authored lines (new `src/runner/ports.ts` + tests). Route: delegated direct.
  Checks: full chain green, 397/397 tests; parent spot check re-ran ports +
  plan + dev-runner tests (41/41). Native review: high risk, granted, 4
  lenses, approved with no blockers, acknowledged. T1 advisories folded in.
- Accumulated-range review (main..`0a6abd4`) also granted and approved.
- T2 advisory findings carried into T3/T4: duplicate declared ports across
  apps not detected (`ports.ts:77-82`); `nextFree` throws despite a
  never-throws contract (`ports.ts:57-66`, `supervisor.ts:174-177`); live plan
  event re-projection (`dev.ts:266-275`); `--json` hides reassignments
  (`dev.ts:263-265`); lenient `--port` parse (`dev.ts:204`); host default
  8081 busy is a hard fail without `--auto-ports` (`plan.ts:129-132`, by
  design, document it); `resolveRef` inconsistency (`plan.ts:138`);
  hardcoded test host port (`dev-runner.test.ts:24-26`).

- T3 done on `feat/dev-wizard-runner-t3`, commit `84d2b09`
  (`feat(dev): build react-native start argv per app by default`), 1495
  authored lines (schema `config`, `ReactNativeCliResolver` port + adapter,
  `start-argv.ts`, `toolchain.ts`, init stops emitting `command`, tests).
  Route: delegated direct. Amended once to match upstream bundler detection
  (rspack fallback when both/none) and resolve `config` against the config
  directory (parent decision: parity with PR #1467 + Atlas path consistency).
  Checks: full chain green, 431/431; parent spot check start-argv + RN CLI
  adapter + dev-runner (55/55). Native review: high, granted, 4 lenses,
  approved, acknowledged. Accumulated-range reviews (main..`7d6fdea`,
  main..`a1e14af`) also granted and approved.
- Carried advisories into T4: duplicate declared ports across apps
  (`ports.ts`); `--json` hides reassignments; document host 8081 hard fail;
  hardcoded/fixed test host ports (`dev-runner.test.ts:24-26`, `:1091`);
  toolchain target duplication (`supervisor.ts:172-187`); toolchain root-key
  collision (`toolchain.ts:53-73`); one app missing RN CLI fails the whole
  run (`plan.ts:150-154`, upstream parity, document it); index-coupled
  assignment (`supervisor.ts:240-241`); `commandless` alias/semantics
  (`supervisor.ts:264`); help exit-2 list incomplete (`help.ts:164-165`);
  init JSON indent (`init.ts:444`).
- Docs (T7) must say default `init` output needs `react-native` installed in
  each app root.

- T4 done on `feat/dev-wizard-runner-t4`, commit `8cd0dbd`
  (`feat(dev): add --platform and --standalone`), 717 authored lines.
  Route: delegated direct. Standalone session composition matches upstream
  (host always runs unless `--apps` excludes it; `--standalone r` adds r).
  Deviations from upstream: duplicate declared ports are a conflict (exit 1);
  a standalone remote with neither `command` nor `root` exits 2. `--json`
  shows `reassignedFrom`. Checks: full chain green, 453/453; parent spot check
  plan + ports + dev-runner (83/83). Native review: high, granted, 4 lenses,
  approved, acknowledged.
- Carried into T5: `ATLAS_APP_PLATFORM` from the user's shell survives when no
  platform is set (delete it from the child env); advisories at
  `supervisor.ts:191-193`, `plan.ts:175`, `help.ts:162-164`, weak
  `--standalone` no-value assert (`dev-runner.test.ts:1338-1341`), dup-port
  free-port race in tests (`:1364-1367`); fixture remote ports 8082/8083
  must be free in tests.

- T5 done on `feat/dev-wizard-runner-t5`, commit `f9053ae`
  (`feat(dev): launch the app on the device once the target is ready`), 1107
  authored lines (new `src/runner/launch-plan.ts`, supervisor `onFirstReady`
  / `spawnOneShot`, `{event:'launch'}`, tests). Route: delegated direct.
  Deviations from upstream: `--launch` + `--no-launch` exits 2; a target with
  no `root` exits 2; failure is a `dev:` stderr line + JSON event instead of
  an in-stream `[launch]` line. Stray `ATLAS_APP_*` env removed when unset.
  Checks: full chain green, 481/481; parent spot check launch-plan +
  process-runner + dev-runner (82/82). Native review: high, granted, 4
  lenses, approved, acknowledged. Range review main..`710deb4` also approved.
- Carried into T6/T7: `declaredPort` overloaded (`plan.ts:39-40`); spawn
  error sentinel (`supervisor.ts:520-527`); one-shot exit chain unguarded
  (`supervisor.ts:532-537`); toolchain silent fallback (`toolchain.ts:66-71`);
  duplicate platform gate (`supervisor.ts:232-234`); duplicated plan emit
  (`dev.ts:424-430`); `dev.ts:250-256`; misplaced toolchain test
  (`launch-plan.test.ts:158-179`).

- T6 done on `feat/dev-wizard-runner-t6`, commit `6861aef`
  (`feat(dev): add interactive wizard for remotes, platform, ports and
  launch`), 1465 authored lines (31 lockfile). `@clack/prompts ^0.9.1` behind
  `PromptPort` with readline fallback; AGENTS.md hard rule 11 names the
  exception. Wording copied from upstream. Gate: no `--apps`, not
  `--no-interactive`/`--ci`/`--json`, TTY on stdin and stdout; wizard also
  runs with `--dry-run` (upstream parity). Deviations: auto-port apps get an
  "automatic free port?" question; choosing "all" clears `--platform`;
  remotes question skipped when there are none. Checks: full chain green,
  515/515; pseudo-TTY smoke by writer (cancel + Enter-through); parent spot
  check wizard + gate + prompts tests (32/32). Native review: medium
  (slice budget), granted, 1 lens, approved, acknowledged.
- Carried into T7 (fix commit): `--launch` + wizard "all" fails only after
  all prompts (`dev-wizard.ts:109-117`); readline multiselect accepts an empty
  selection (`prompts-readline.ts:108`); preselect-all unasserted in tests
  (`dev-wizard.test.ts:174-188`). The first-pass plan exits 2 on a toolchain
  failure of any app before the wizard shows (document it).

- T7 done on `feat/dev-wizard-runner-t7`: `4b3663a` (`fix(dev): reject empty
  readline selections and hide 'all' under --launch`) and `35cb4dc` (`docs:
  document the interactive dev runner`; PRD §7.1 + §7.1.1, README dev
  section, demo runbook, new `atlas-runner` skill). 456 authored lines.
  Checks: full chain green, 518/518, 5 skills in sync; parent spot check
  wizard + prompts (29/29). Native review: medium, granted, 1 lens, approved,
  acknowledged. Demo runbook marks the wizard, `--dry-run`, `--launch` and
  Atlas-built argv as "not yet re-verified on the showcase".
- Open follow-ups: host-only session reachable in clack (`required: false`)
  but not in readline (empty line = preselected all) — owner decision;
  T7 review advisories on `dev-wizard-gate.test.ts:177-187` (dropped exit
  code assert, weak "not offered" proof) and readline re-ask
  (`prompts-readline.ts:108-122`); carried T5 code advisories
  (`declaredPort`, spawn error sentinel, one-shot exit chain, toolchain
  silent fallback); re-verify the runbook against the real showcase.
- Engram mirror: pending (session conflict on save).

## Next step

Owner: open the tracker draft PR (`feat/dev-wizard-runner` → main) and the
chained slice PRs t1..t7, and re-verify the demo on super-app-showcase.
