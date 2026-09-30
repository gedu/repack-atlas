# Showcase Demo — super-app-showcase on repack-atlas

Status: **in progress** · Created: 2026-09-30 · Engram mirror: `odd/showcase-demo/tasks`

## Objective

Prove repack-atlas works on a REAL Module Federation workspace: the
super-app-showcase fork at
`/Users/eduardo.graciano/Documents/CK/internals/forks/super-app-showcase`
(pnpm monorepo, apps under `packages/{host,auth,trading,wallet}`, sdk lib,
process configs under `mprocs/`). Produce real doctor findings, a live
`repack-atlas dev` + Studio session, and evidence for the README GIF.

## Why

Repo-foundation (T0–T11) is green on fixtures; the PRD demo story (docs/PRD.md
§8, §16.5) requires the same tooling working against a non-toy workspace with
real shared-dependency drift and real dev servers.

## Constraints

- NO push / PR / publish anywhere. Owner decides delivery. Showcase changes
  stay on a local feature branch in the fork; never sent upstream.
- Conventional Commits, no AI attribution. Artifacts English, chat Spanish.
- Report the REAL output of every check (AGENTS.md rule 9).
- Workers sometimes return empty — parent verifies with `git status` +
  re-runs checks (spot-check gate).
- Kill stale listeners on 8099 before Playwright/Studio.
- Vendored fence: any change under `src/repack-bridge/vendored/**` needs a
  VENDORED.md adjustment-ledger entry + tests.
- Showcase pins Node >= 24.18.0 (engineStrict) — local node v24.18.0 OK;
  pnpm via packageManager 11.20.0 (corepack may fetch it).

## Route

Delegated direct per task (install/build = bounded per-action workers;
multi-file config edits = one writer). SDD not requested, not used. No TDD
mode asserted for this repo beyond its configured `pnpm test` (fixtures);
bridge changes follow existing test patterns.

## Tasks

- [x] D0 — Refresh `repack-atlas` build (`pnpm build`) so the `file:` dep
      consumes current dist. Check: build exit 0 + dist mtimes.
- [x] D1 — `pnpm install` in showcase; smoke-build ONE mini-app (auth) with
      its own rspack config BEFORE touching any config. Check: real install +
      build output pasted; no config modified yet.
- [x] D2 — Feature branch `atlas-demo` in showcase; add `repack-atlas` as
      `file:` dep to host + 3 mini-apps. Check: install resolves, `git
      status` matches intent, work-unit commit.
- [x] D3 — Add `FederationManifestPlugin` (`repack-atlas/plugin`) +
      `IntrospectionPlugin` (`repack-atlas/introspection`) to each app's
      rspack.config.ts (host role=host, apps role=remote; ports 8081/9001/
      9002/9003 from start scripts). Check: rebuild auth with plugins,
      manifest asset + `.repack-atlas/introspection.json` appear. Commits.
- [x] D4 — Dev-server serving: asset NOT served in watch mode → added
      wrapper-level `writeToDisk` (repack-atlas 35f3604, VENDORED.md B1).
      Enabled in showcase (commit 3138380). Later correction: the dev
      server DOES serve `<appRoot>/repack-federation-manifest.json` once it
      exists on disk (parent A/B test: delete→404, rebuild→200). The
      original 404 was the true cause; writeToDisk is still the mechanism.
- [x] D5 — `repack-federation.json` authored at showcase root (file refs,
      ports 8081/9001/9002/9003, `pnpm --filter <app> start` commands);
      showcase commit 4186a5d. `init --dry-run` cannot discover `packages/`
      layout (expects `apps/` or workspace subdir with rspack.config.*) →
      documented limitation, config hand-authored.
- [x] D6 — Doctor on real workspace: config parses, exit 0, 62 warnings
      (57 EAGER_ADVISORY + 5 HEURISTIC_ADVISORY), 0 errors. Honest: the
      clean showcase has no drift/cycle — ERROR paths get deliberate
      evidence in D6b (tamper-test on gitignored manifests).
- [x] D6b — Error-path evidence (reversible, gitignored manifests):
      tampered react version → SHARED_VERSION_DRIFT + exit 1; synthetic
      auth↔trading cycle → REMOTE_CYCLE warning at exit 0 (by design);
      no-config dir → exit 2; corrupt wallet manifest → exit 2 with a
      trailing "could not answer" line (no named finding; remote's
      warnings vanish 62→42 — flagged as a UX gap). All restored, diffs
      clean, baseline exit 0.
- [x] D7 — `repack-atlas dev --ci --json` live: 4 apps ready (host 8081,
      trading 9001, wallet 9002, auth 9003), Studio http://127.0.0.1:8099/
      200, /api/graph = 4 ready apps + 5 REAL edges (incl. trading→auth
      and wallet→auth, genuine showcase config) + 62 findings, SSE works.
      Runner left RUNNING (PID 84461) for the owner's GIF; kill to stop.
      NOTE: earlier worker mislabeled 9001/9002 swap — parent verified
      9001=trading, 9002=wallet from served manifests.
- [x] D8 — Dev-facing demo run plan written at docs/demo-showcase.md
      (English runbook: prep, happy path, error-path tamper recipes,
      exit-code story, GIF checklist, gotchas from this session).

## Progress log

- 2026-09-30 D0: `pnpm build` exit 0; dist mtimes current.
- 2026-09-30 D1: node v24.18.0 / pnpm 11.20.0; `pnpm install` exit 0 (1249
  packages). Smoke build auth dev-mode `react-native bundle --dev true`
  exit 0, Rspack 2.1.7 ~6s, container + expose chunks in
  `packages/auth/build/outputs/android/remotes/`. Prod bundling (`--dev
  false`) fails without uncommitted `code-signing.pem` (CodeSigningPlugin)
  — demo uses dev mode.
- 2026-09-30 D2: commits `2b2bcb9` (deps) + `443ba51` (plugins) on
  `atlas-demo`. Gotcha: pnpm resolves `file:` relative to each package dir
  → `file:../../../repack-atlas`, not `../repack-atlas`.
- 2026-09-30 D3: ports are 8081 host / 9001 trading / 9002 wallet / 9003
  auth (explicit `--port` in start scripts; no collision). Manifest asset
  lands in `build/generated/android/` (not `outputs/`). Introspection facts
  at `<app>/.repack-atlas/introspection.json` (gitignored). 19-entry static
  shared array mirrors `packages/sdk/lib/dependencies.json`. Parent
  spot-check: git clean, both artifacts exist, 2-commit stat verified.
- 2026-09-30 D4 (atlas side): dev server 404s the manifest on every path
  variant and watch mode never writes it to disk → added `writeToDisk` at
  the Atlas-owned wrapper (`plugin.ts`), vendored files byte-identical,
  VENDORED.md section "Bridge additions (non-vendored)" B1. repack-atlas
  commit `35f3604`; build/lint/typecheck 277 tests/check:vendored all
  green; parent re-ran `pnpm test`: 277/277.

- 2026-09-30 D4 (showcase side): `writeToDisk: true` in 4 configs; commit
  `3138380`. Manifest written at app root on every compilation; watch
  rebuild updates mtime. Later A/B (parent): served 200 only while the
  on-disk file exists (delete→404, rebuild→200) — dev server serves the
  app-root file once writeToDisk created it.
- 2026-09-30 D5: config commit `4186a5d`; `init --dry-run` cannot see
  packages/ layout (exit 2) — hand-authored config documented.
- 2026-09-30 D6: clean-showcase doctor = 0 errors / 62 warnings
  (57 EAGER_ADVISORY + 5 HEURISTIC_ADVISORY) / exit 0, static and live
  identical. No natural drift/cycle in the real repo — error codes proven
  via reversible tamper in D6b instead.
- 2026-09-30 D6b: DRIFT exit 1; cycle → REMOTE_CYCLE warning exit 0 (by
  design); corrupt + no-config → exit 2. UX gap noted: corrupt remote has
  no named finding, only trailing "could not answer" + its warnings vanish.
  All restored byte-identical; tree clean.
- 2026-09-30 D7: dev supervisor PID 84461 live, Studio :8099, graph 4 ready
  apps / 5 real edges / 62 findings, SSE works; left running for GIF.
  Parent corrected worker's 9001/9002 mislabel (9001=trading, 9002=wallet,
  verified via served manifest ids).
- 2026-09-30 D8: docs/demo-showcase.md written; repack-atlas commits
  `35f3604` (bridge) + `e98f745` (docs). Showcase branch `atlas-demo`:
  `2b2bcb9`/`443ba51`/`3138380`/`4186a5d`. Nothing pushed anywhere.

## Next step

Owner records the GIF (Studio live at 127.0.0.1:8099, runner PID 84461 —
kill to stop). Open follow-ups surfaced by the demo: (1) doctor UX —
corrupt remote has no named finding (exit-2 line only); (2) `init` app
discovery does not cover non-`apps/` layouts; (3) IntrospectionPlugin
static shared arrays could accept the map + version resolver.
