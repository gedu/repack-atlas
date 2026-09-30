# doctor: named unreadable-manifest finding; introspection: MF shared map

## Objective

Make a corrupt manifest point at the app that broke, and let users pass the
same Module Federation `shared` object to both plugins.

## Problem

- #7: one unreadable remote manifest makes `doctor` print `could not answer`
  and exit 2, with nothing naming the app or file.
- #10: `IntrospectionPlugin` only accepts `shared` as an array, so users keep
  a second hand-written copy next to their MF `shared` map.

## Decisions

- #7 exit code (decided 2026-09-30, owner delegated): an unreadable manifest
  is a named error finding `MANIFEST_UNREADABLE` and `doctor` exits `1` when
  it can still answer for the other apps. Exit `2` stays for runs that cannot
  answer at all (missing or invalid config, host unreadable, or every remote
  manifest exists but is unreadable; missing manifests keep exit `1`, or `0`
  with `--allow-missing-manifests`).
- #10: accept the MF map and keep the array; normalize to the array shape;
  resolve a missing `version` from the installed package and mark its
  confidence honestly.

## Tasks

- [ ] T1 (#7) `MANIFEST_UNREADABLE` finding, fixture, tests, `--json`, exit
      code docs, `docs/demo-showcase.md` "corrupt" row from real output.
      Route: delegated direct (writer trigger: core rule + CLI + fixture +
      docs).
- [ ] T2 (#10) MF `shared` map accepted, unit tests for both shapes, demo
      wiring in `docs/demo-showcase.md` passes the same object. Route:
      delegated direct.

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` (+ `pnpm
check:vendored` if the bridge vendored code is touched).

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `feat/doctor-unreadable-and-shared-map` from `9ddc23e`.
