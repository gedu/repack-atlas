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

- [x] T1 (#7) `MANIFEST_UNREADABLE` finding, fixture, tests, `--json`, exit
      code docs, `docs/demo-showcase.md` "corrupt" row from real output.
      Route: delegated direct (writer trigger: core rule + CLI + fixture +
      docs).
- [x] T2 (#10) MF `shared` map accepted, unit tests for both shapes, demo
      wiring in `docs/demo-showcase.md` passes the same object. Route:
      delegated direct.

## Checks

`pnpm build && pnpm typecheck && pnpm lint && pnpm test` (+ `pnpm
check:vendored` if the bridge vendored code is touched).

## TDD

Mode: off (no project/session TDD config). Runner: `pnpm test`.

## Progress

- Branch: `feat/doctor-unreadable-and-shared-map` from `9ddc23e`.
- T1 `497bb3e` (+198/-46); T2 `249d1f2` (+381/-6).
- RDD `9ddc23e..497bb3e` medium, 1 lens, approved + ack
  (review-b1364e537d50d361); advisory WARNING: corrupt + missing mix.
- RDD `497bb3e..249d1f2` medium, 1 lens, approved + ack
  (review-04a33c15492aaf47); suggestions: key filtering, duplicates, error
  branches.
- Follow-ups: `1130c00` (exit 2 when nothing compared) was wrong: it broke the
  PRD §7.1 missing-manifest contract; corrected by `88e9f32` (exit 2 only when
  every remote is unreadable). `4e587ad` normalizes every shared form and
  rejects duplicates.
- RDD `249d1f2..88e9f32` medium, 1 lens, approved + ack
  (review-c46be315ab73911b). Open suggestion: no test that singleton/eager/
  requiredVersion survive on Atlas-shaped array entries.
- Evidence (parent, `88e9f32`): `pnpm test` 338/338; `doctor` missing fixture
  exit 1, with `--allow-missing-manifests` exit 0; corrupt fixture exit 1.
- Delivery: one PR, `size:exception` (about 760 lines; owner prefers fewest
  PRs).
