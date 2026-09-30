# doctor: warn when no remote manifest was compared

## Objective

Stop a run where every remote manifest is missing from reading like a clean
pass (#26).

## Problem

With `--allow-missing-manifests`, a workspace whose remotes are all missing
exits `0` and prints only per-remote warnings. Nothing was compared, but the
run looks green.

## Decisions

- New finding `NOTHING_COMPARED`, severity `warning`, confidence `static`,
  emitted when remotes exist and none of them was compared (every remote is
  missing or unreadable).
- Exit codes do not change (AGENTS.md rule 6, PRD 7.1): missing manifests stay
  `1`, or `0` with `--allow-missing-manifests`; exit `2` stays only for "every
  remote manifest exists but is unreadable".
- The finding is also emitted without the flag (all-missing exits `1` anyway),
  so the report says the same thing in both modes.
- Not emitted when every remote is unreadable: that run is exit `2` and
  `MANIFEST_UNREADABLE` already names each app.
- Mixed missing + unreadable (no exit `2`, nothing compared) does get it.

## Tasks

- [x] T1 (#26) Core rule, fixture `fixture-nothing-compared`, expectation
      table, core + CLI tests, README/PRD/skill docs. Route: delegated direct
      (single writer; core + fixture + tests + docs).

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm agent:check`,
`node scripts/commit-check.mjs --range main..HEAD`, plus real CLI runs on the
new fixture and `fixture-missing-remote-manifest`, with and without
`--allow-missing-manifests`.

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `feat/doctor-nothing-compared` from `3248541`.
- T1 `e4c66c4` (+489/-20, 27 files). Route: delegated direct (single writer).
- Evidence: `pnpm build`, `typecheck`, `lint`, `agent:check` clean; `pnpm test`
  361/361. `fixture-nothing-compared`: exit 1 (2 errors, 1 warning), exit 0
  with `--allow-missing-manifests` (0 errors, 3 warnings, `NOTHING_COMPARED`
  present). `fixture-missing-remote-manifest`: exit 1 / 0, no new finding.
- Note: `--fail-on-warnings` escalates `NOTHING_COMPARED` like any warning.
