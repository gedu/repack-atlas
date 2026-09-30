# init: workspace-glob discovery, derived commands, port validation

## Objective

Make `repack-atlas init` produce a config that `repack-atlas dev` can run
without hand edits, on monorepos that keep apps outside `apps/*`.

## Problem

- #9: init never writes `command`, and copies introspected ports without the
  1..65535 integer rule the config validator enforces.
- #8: init only scans `apps/*` (or workspace subdirs); the showcase keeps apps
  under `packages/**`, so nothing is discovered.

## Scope

- Derive `command` per app when safe; report when it cannot be derived.
- Validate introspected ports with the shared rule; drop invalid ones with a
  report warning.
- Discover apps from `pnpm-workspace.yaml` `packages:` and `package.json`
  `workspaces` globs, falling back to the current `apps/*` behavior.
- Update the `docs/demo-showcase.md` gotcha (and fix §5: atlas-demo has 5
  commits, not 3).

Out of scope: manifest ref convention (`manifests/<dir>.json`) stays as is.

## Constraints

- No new runtime dependencies (no YAML or glob library); minimal parser for
  the `packages:` list only.
- `buildInitPlan` never throws; no config evaluation.
- Delivery: aim for one PR (Closes #9, Closes #8); ~400 authored lines is a
  heuristic, chain only if it clearly overflows. Strategy: ask-on-risk.

## TDD

Mode: off (no project/session TDD config found in AGENTS.md). Runner:
`pnpm test`. Ordinary functional checks apply.

## Tasks

- [x] T1 (#9) derived `command` + introspected port validation, tests.
      Route: delegated direct (writer trigger: init.ts + tests + fixture).
- [x] T2 (#8) workspace-glob discovery + fixture under `packages/**`, tests,
      docs gotcha + §5 fix. Route: delegated direct.

## Acceptance criteria

- `init --dry-run --json` on a fixture includes `command` where derivable and
  the generated config passes `validateFederationConfig`.
- An out-of-range introspected port is dropped and reported.
- A fixture with apps under `packages/*` is discovered; non-app packages in
  the same globs are not.

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test`

## Progress

- Branch: `feat/init-discovery-commands`.
- T1 done in `c8a93c1` (+253/-4): `isValidPort` shared in core; command from
  lockfile-detected package manager + `scripts.start`; per-app `notes`.
- T2 done in `04d4b93` (+322/-36): globs from `pnpm-workspace.yaml` and
  `package.json` `workspaces` (`*`, `**`, `!` exclusions); app = rspack/webpack
  config or introspection file; fixture `fixtures/discovery-packages/`.
- Evidence (parent re-run on `04d4b93`): `pnpm test` 307/307 pass,
  `pnpm lint` clean, `pnpm typecheck` clean.
- Size: 575+/40- total, over the 400 budget; delivery plan is two chained
  PRs, one per commit (#9 then #8).
- RDD slice 1 (`main..c8a93c1`, branch `feat/init-commands`): medium, 1 lens
  (reliability), granted, approved and acknowledged (lineage
  review-df0b87f54e861276). Advisory WARNING: package name interpolated
  unquoted into the command; SUGGESTION: untested deriveCommand branches.
- Follow-up `8e1310b` (+76): command only for valid npm package names, tests
  for the missing branches. Parent re-run: `pnpm test` 311/311 pass.
- RDD slice 2 (`c8a93c1..fa59707`): high, 4 lenses, granted, approved and
  acknowledged (lineage review-811e5e3b31ea951c). Advisory warnings: unbounded
  `**` walk, no symlink-cycle guard, negation-only globs skip the fallback,
  basename collisions.
- Follow-up `394c7b0` (+112/-12): `**` stops below apps, prunes native/build
  dirs, depth cap 8; positive-glob-only branch; dashed names on basename
  collisions. Parent re-run: `pnpm test` 314/314 pass.
- RDD `fa59707..394c7b0`: medium, 1 lens, granted, approved and acknowledged
  (lineage review-1a4ae125011b9c77).
- Open follow-ups (advisory, not fixed): `!` exclusions ignored in the
  `apps/*` fallback; dashed collision names are not re-checked for
  uniqueness; ios/android/Pods pruning and the depth cap have no direct test;
  the depth cap drops deep apps silently.
- Delivery: PR 1 `feat/init-commands` (c8a93c1, Closes #9); PR 2 stacked on
  it, `feat/init-discovery-commands` (Closes #8). Push/PR on owner decision.
