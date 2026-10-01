---
name: atlas-runner
description: >-
  Change the dev runner safely: pure plan builder, port rules, per-app
  react-native argv, device launch, wizard and PromptPort seams, tests with a
  stub RN CLI and the exit-code/--json contract. Trigger: touching
  repack-atlas dev, src/runner/, src/cli/dev.ts, src/cli/dev-wizard.ts, the
  prompt adapters, a dev flag, or a dev --json event.
metadata:
  auto_invoke:
    - "changing the dev runner, its flags or its --json events"
    - "changing the dev wizard or the prompt adapters"
---

# Changing the dev runner

`repack-atlas dev` is a wizard plus flags feeding one plan. Keep that shape:
behavior lives in the plan, the supervisor only executes it.

## Seams (where each change goes)

| Change | File | Rule |
|---|---|---|
| Which apps run, ports, argv, platform, standalone | `src/runner/plan.ts` (`buildDevPlan`) | Pure: no fs, no spawn, no clock. Same input, same plan. |
| Port declared/default/busy handling | `src/runner/ports.ts` | Probe before spawning; report every conflict together (exit 1). |
| `react-native start` argv, bundler detection | `src/runner/start-argv.ts` | Built per app from its own root. A config `command` is a verbatim override and gets platform/standalone only as `ATLAS_APP_*` env. |
| Launch one-shot (`run-<platform> --no-packager`) | `src/runner/launch-plan.ts`, supervisor `onFirstReady` | Exactly once, on the target's first ready; a failure never fails the session. |
| Spawn, readiness, shutdown | `src/runner/supervisor.ts` | Needs the whole plan first; no half-started sessions. |
| Flags, gates, exit codes, events | `src/cli/dev.ts`, `src/cli/help.ts` (`DEV_HELP`) | Usage errors exit 2 before anything is read or spawned. |
| Questions | `src/cli/dev-wizard.ts` | Input source only: answers become the same plan inputs as flags. No second gate. |
| Prompt backends | `src/adapters/prompts-*.ts` behind `PromptPort` (core) | `@clack/prompts` is the only runtime dependency; dynamic import, readline fallback. |

## Hard rules

- Exit codes: `0` clean (also a wizard cancel) · `1` port conflict or an app errored · `2` could not answer. Keep `1` and `2` distinguishable.
- `--json` events (`plan`, `studio`, `app`, `launch`, `exit`) only grow: add fields, never rename or drop.
- A new flag needs, in one change: `DEV_HELP`, a wizard answer or an explicit "flag only" reason, README/PRD §7.1.1 rows, and tests.
- The wizard must not offer an answer the flags would reject (for example "all" platform under `--launch`).
- The readline fallback never returns an empty selection (it re-asks); the clack adapter passes `required: false`, so an explicit empty pick means host only there.

## Testing

- Plan and port logic: unit tests on `buildDevPlan` and `ports.ts`, no processes.
- Wizard: `tests/cli/fake-prompts.ts` scripts answers; assert the questions asked, not only the result.
- Spawned runs: `tests/runner/dev-runner.test.ts` uses `fixtures/workspace/tools/stub-bundler.mjs` and a stub `react-native` CLI (`makeApp`) that records argv and cwd. Never require a simulator or a real RN install.
- Use free ports (`freePort()`); the fixture remotes keep 8082/8083, so wait for them to be free between tests.

## Verify

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
node dist/cli.js dev --workspace fixtures/workspace --dry-run --no-interactive; echo "exit=$?"
```

Report the real output. A wizard change also needs a manual check on a TTY: cancel with Ctrl-C (exit 0) and Enter-through.
