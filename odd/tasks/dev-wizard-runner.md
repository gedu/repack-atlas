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

- [ ] T1 Pure plan + `--dry-run`: extract a pure `buildDevPlan`, add
      `{event:'plan'}` (additive), human plan table, no spawn, no Studio.
- [ ] T2 Ports: `--port` host override, default 8081, `--auto-ports`, all
      conflicts reported (exit 1).
- [ ] T3 Default argv: config `config` field, RN CLI resolver adapter
      (`createRequire` from app root), `detectBundler`, `command` as override;
      `init` stops emitting `command`.
- [ ] T4 `--platform ios|android`, `--standalone <remote>` (gated on
      `standalone: true`), env contract for `command` apps.
- [ ] T5 Launch: `--launch/--no-launch/--device`, one-shot
      `run-<platform> --no-packager` on the target's first ready, `[launch]`
      prefix, exactly once, killed on shutdown.
- [ ] T6 Wizard: `PromptPort`, clack via dynamic import, readline fallback;
      steps remotes → platform → launch → ports → standalone; gate and cancel.
- [ ] T7 Docs: PRD §7.1 and related lines, README dev section, demo runbook
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

## Next step

T1.
