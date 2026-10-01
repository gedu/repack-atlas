# Dev runner: Re.Pack 5.x compatibility and showcase verification

## Objective

Make the interactive dev runner (#35, PR #36) work against published Re.Pack
5.x on super-app-showcase, close the gga/review follow-ups, and re-verify the
demo runbook on the real showcase.

## Problem

Atlas builds `react-native start --bundler <b> [--standalone]` like upstream
PR #1467, but `--bundler` and `--standalone` only exist in that PR's Re.Pack.
On published Re.Pack 5.3.0 (super-app-showcase) `start` fails with
`error: unknown option '--bundler'`. In 5.x the bundler is chosen by the
app's `react-native.config.js` (`commands: require('@callstack/repack/commands/rspack')`).
Repo tests passed because the stub RN CLI accepts any option.

## Decisions

- Feature-detect the installed `start` command's options per app (resolved
  from the app root, AGENTS.md rule 4). Pass `--bundler` / `--standalone`
  only when declared. Without `--bundler` support, omit it (the RN config
  selects the bundler). `--standalone` requested but unsupported → exit 2
  with a clear reason.
- The showcase drops its `command` overrides on the local `atlas-demo` branch
  so Atlas builds the argv (never pushed without the owner's call).

## Tasks

- [ ] T1 Feature-detect start options; argv omits unsupported flags; stub CLI
      in tests declares its options so both shapes are covered.
- [ ] T2 Follow-ups: `--apps` wording (`remotes.<name>` → bare name) in PRD
      and DEV_HELP; AGENTS.md `runner/` layout line; gate test exit-code
      asserts; readline re-ask advisory.
- [ ] T3 Re-verify on super-app-showcase (dry-run, `--apps auth`, full
      session, wizard under a pseudo-TTY) and update `docs/demo-showcase.md`
      with verified output; drop "not yet re-verified" marks only for what ran.

Route per task: T1 delegated direct (2+ non-trivial files); T2 delegated
direct; T3 parent runs the showcase, delegated writer for the doc.

## Checks

`pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm agent:check &&
pnpm check:vendored`, `pnpm check:commits --range main..HEAD`.

## TDD

Mode: off. Runner: `pnpm test`.

## Delivery

Single PR to main (`size:exception` if over 400), per the owner's last
delivery (#36).

## Progress

- Bug reproduced: `node <rn cli> start --bundler rspack ...` in
  `super-app-showcase/packages/auth` → `error: unknown option '--bundler'`.
  `start --help` on 5.3.0 lists `--port --platform --no-interactive --config
  --no-reverse-port ...`, no `--bundler`, no `--standalone`.

## Next step

T1.
