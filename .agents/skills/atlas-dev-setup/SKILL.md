---
name: atlas-dev-setup
description: >-
  Fastest working path from a fresh clone of this repo to green checks: pnpm
  install, build, typecheck, lint, test, and the fixture doctor tests that prove
  the tool runs without a simulator. Trigger: set up, install, build, run, test,
  or debug this repo locally; "it does not build"; fresh clone; CI failing on a
  check you cannot reproduce locally.
metadata:
  auto_invoke:
    - "setting up this repo for the first time"
    - "reproducing a failing CI check locally"
    - "running the fixture test suite"
---

# Atlas dev setup

## Prerequisites

- Node `>=20` (`node -v`), pnpm `>=10` (`pnpm -v`). No simulator, no CocoaPods,
  no Xcode needed for anything in this repo's own test suite.

## Fresh clone → green

```bash
pnpm install     # creates node_modules + verifies pnpm-lock.yaml
pnpm build       # tsc: src -> dist (declared + sourcemaps)
pnpm typecheck   # tsc --noEmit over src AND tests (tests never emit)
pnpm lint        # eslint, including the bridge-fence and core-boundary rules
pnpm test        # node:test via tsx
pnpm agent:check # agent skills / symlinks / AGENTS.md tables in sync
```

Run them in that order: `build` before `test`, because integration tests spawn
`dist/cli.js`.

## Install gotchas

- `pnpm-lock.yaml` is committed. If you only changed source code, use
  `pnpm install --frozen-lockfile` to prove the lockfile is honest.
- `@callstack/repack` is a **peerDependency** and must NOT appear in
  `node_modules/@callstack`. It resolves from the *user's* project at runtime
  (see `atlas-bridge-vendoring`). If it shows up after an install, check
  `autoInstallPeers` in `pnpm-workspace.yaml`.
- pnpm >= 11 blocks dependency build scripts by default. `esbuild` (used by
  `tsx`) needs its postinstall; it is allowed via `allowBuilds` in
  `pnpm-workspace.yaml`. If you see `ERR_PNPM_IGNORED_BUILDS`, that key was
  lost.

## Proving the tool actually works

The fixture doctor suite is the fast end-to-end proof and needs no device:

```bash
pnpm test                                    # fixture suite included
node dist/cli.js doctor --fixtures fixtures/fixture-version-drift --json
echo "exit=$?"                               # expect 1 (drift found)
node dist/cli.js doctor --fixtures fixtures/fixture-clean --json
echo "exit=$?"                               # expect 0
```

Exit-code semantics: `0` clean, `1` findings present, `2` the tool could not
answer at all. A run that exits `2` when you expected `0` or `1` is a broken
tool, not a failing project — fix the command before blaming the fixtures.

Fixtures live in `fixtures/*` (one broken variant per doctor finding, each with
a README stating the provoked finding and expected exit code). Each variant must
stay minimal: Rspack + MF2, no real UI, no simulator, no network.

## Timing budget

The whole suite must stay in seconds; `pnpm test` on a warm cache is a
few-hundred-millisecond job. If something pushes it toward minutes, treat it as
a regression to fix, not a fact of life — that budget is a product requirement
(PRD §5 acceptance, §9).
