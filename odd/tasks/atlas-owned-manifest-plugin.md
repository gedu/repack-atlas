# Record the manifest plugin as Atlas-owned

## Objective

Remove the vendor-to-export swap plan from docs and comments (#32): the
manifest plugin is an Atlas-owned fork and a supported Atlas package.

## Problem

Re.Pack `feat/federation-manifest` (commit `c5df67f0`, PR #1463) will never be
merged into Re.Pack (owner decision, 2026-09-30). PRD, `VENDORED.md`, the
`atlas-bridge-vendoring` skill, AGENTS.md and several code comments still plan
to delete the vendored code once core exports it.

## Decisions

- Docs and comments only; no behavior or code-logic change.
- Per-file provenance (upstream path, commit `c5df67f0`) and MIT headers stay:
  license obligation and history.
- `repack-atlas/plugin` and `repack-atlas/introspection` are Atlas public API;
  Re.Pack / Module Federation compatibility is validated by Atlas.
- Out of scope: moving code out of `vendored/`, relaxing the lint fence.

## Tasks

- [ ] T1 (#32) PRD (R2, 6.2, 8.2, checklist), VENDORED.md, bridge skill,
      AGENTS.md, README, demo-showcase and code comments. Route: delegated
      direct (single writer; 2+ non-trivial files).

## Checks

`pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm agent:check &&
pnpm check:vendored`, `node scripts/commit-check.mjs --range main..HEAD`, and
`rg -i swap` outside `odd/`.

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `docs/atlas-owned-manifest-plugin` from `0f744b2`.
- T1 `597951d` (11 files, docs and comments only). Route: delegated direct.
- Evidence: `pnpm build`, `lint`, `typecheck` clean; `pnpm test` 362/362;
  `agent:check` OK; `check:vendored` OK (6 files). Remaining `rg -i swap`
  hits outside `odd/` are only the decision record (PRD, VENDORED.md,
  AGENTS.md) and unrelated `swaps` in a Playwright comment.
