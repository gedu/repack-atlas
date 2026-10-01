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

- [x] T1 Feature-detect start options; argv omits unsupported flags; stub CLI
      in tests declares its options so both shapes are covered.
- [x] T2 Follow-ups: `--apps` wording (`remotes.<name>` → bare name) in PRD
      and DEV_HELP; AGENTS.md `runner/` layout line; gate test exit-code
      asserts; readline re-ask advisory.
- [x] T3 Re-verify on super-app-showcase (dry-run, `--apps auth`, full
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

- T1 `6fb6484` (`fix(dev): pass only start options the installed Re.Pack
  declares`): `startOptions(appRoot)` on the RN CLI resolver port loads the
  app's react-native.config in a child node; stub CLI now rejects undeclared
  options; `repack5` and `pr1467` stub shapes. Showcase auth detected options:
  `--port --host --https --key --cert --no-interactive --reset-cache --json
  --log-file --log-requests --platform --no-reverse-port --verbose
  --max-workers --config --webpackConfig` (no `--bundler`, no `--standalone`).
- Second bug found on the live showcase run: `node <realpath cli.js> start`
  cannot find platform plugins under pnpm (`configs[0]` undefined,
  `Unrecognized platform: ios`, `Cannot find module
  '@react-native/community-cli-plugin'`). The pnpm `.bin/react-native` shim
  exports the needed NODE_PATH. Fixed in `1895aa9` (`fix(dev): run
  react-native through the app's bin shim`), shim-first with `node cli.js`
  fallback, for start and launch.
- T2 `2c6f48c` (`docs(dev): fix --apps wording and close review follow-ups`).
- Checks after `1895aa9`: full chain green, 541/541, `check:commits` OK.
- Live showcase (local `atlas-demo`, `command` fields removed, not committed):
  dry-run argv `node_modules/.bin/react-native start --port N
  --no-interactive`; `dev --json --no-interactive` → 4/4 ready in 3s, auth
  manifest HTTP 200, Studio `/api/graph` 5 edges (host→auth, host→trading,
  host→wallet, trading→auth, wallet→auth); SIGINT → `{event:'exit',code:0}`,
  all ports freed.
- Engram fixed: the session ended at `/clear`; registered
  `claude-code-repack-atlas-20261001-dev-runner` and mirrored.

- T3: `dev --apps auth --no-studio --no-interactive` serves the auth manifest
  (200, `id: auth`, react 19.2.8) ~1s after ready; wizard `--dry-run` under a
  pseudo-TTY ran remotes → platform → launch-skipped note → ports and exit 0
  (clack wraps one char per line at 0 columns; record in a real terminal).
  Runbook updated in `299300d` (`docs: verify the demo runbook against the
  real showcase`) plus the showcase commit list. Showcase commits (local
  `atlas-demo`, not pushed): `28d43bf` drop `command`, `caf33f4` lockfile.
  Still unverified: `--launch --platform ios` (simulator), `init` output on
  the showcase.

- Native review of `6fb6484..a4f692a` (code + docs): high, granted, 4 lenses,
  approved, acknowledged. gga (PR mode): PASSED with 5 notes.
- Review + gga warnings fixed in `8184cca` (`fix(dev): quote Windows shim args
  and fail on undeclared start flags`): cmd.exe quoting for `.cmd` shims
  (unit-tested only; no Windows run), undeclared `--config`/`--platform` →
  exit 2, shim used only when it runs the resolved react-native, inspect
  timeout keeps a printed report, stale comments/help. Checks: 552/552;
  parent spot check start-argv + RN CLI adapter + plan (68/68); showcase
  dry-run argv unchanged. Native review for this commit: declined by the
  owner (candidate-scoped); independent check via gga.

## Next step

PR to main, CI, merge.
