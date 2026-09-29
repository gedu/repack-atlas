# Feature: repo-foundation

Route: delegated (writer trigger fires for most tasks; mapping done in Step 0/1)
Engram mirror: `repack-atlas/repo-foundation/tasks`
PRD: `docs/PRD.md` (approved verbally 2026-09-29, open questions in §16 still pending owner calls)

## Objective

Build the repository "as it should be" (base standards + real code ported from the
three stacked Re.Pack PRs) so the demo on the super-app-showcase fork becomes a
thin integration step.

## Problem the port creates (why this is not a 1:1 copy)

The PRs live inside `packages/repack` as one blob under `commands/federation`.
Here they must land in the hexagonal layout: bundler-agnostic logic (graph,
cycles, drift, semver ranges, manifest schema) into `src/core/` **without Re.Pack
imports**; Re.Pack-shaped things (manifest plugin, rspack config introspection,
runner process management) behind `src/repack-bridge/` + adapters. Expect a real
decoupling pass, not a copy-paste.

## Scope

In: package scaffold, agent files + sync, bridge + vendoring, core port, fixture
workspace, CLI bin, studio, runner, CI.
Out: showcase-fork integration (next feature), npm publish, MCP/Proxy (PRD §16).

## Constraints

- No push / PR / repo creation / publish. Conventional Commits, no AI attribution.
- Artifacts in English.
- Lint fence: nothing outside `src/repack-bridge/` imports `vendored/`.
- `vendored/` keeps MIT headers; `VENDORED.md` per file with source + commit c5df67f0.
- Re.Pack resolved from the user project via `createRequire(projectRoot/package.json)`.

## Tasks

- [x] T0. Owner answers PRD §16 (2026-09-29): bin = `repack-atlas` (full, no
      shortcut); Proxy/MCP deferred (phase 3 candidates); config introspection =
      opt-in Atlas plugin in user configs for the demo; Node floor >=20.
- [ ] T1. Scaffold: pnpm workspace, TS config, ESLint (+bridge fence, +core
      boundary rules), tsconfig strict, `package.json` (peerDep @callstack/repack),
      `.gitignore`, biome/eslint choice per fork style.
- [ ] T2. Agent files: AGENTS.md (rules + skills table + auto-invoke),
      CLAUDE.md one-liner, `.agents/skills/` day-1 ★ skills, `.claude/skills`
      symlinks, `scripts/agent-sync` with `--check`.
- [x] T3. Bridge: `src/repack-bridge/index.ts` surface + `vendored/` manifest
      plugin (from #1463 `plugins/federationManifest/*`) + VENDORED.md +
      `resolveRepack(projectRoot)` helper.- [x] T4. Port core (agnostic): manifest schema types, doctor rules
      (drift/singleton/eager/cycles via semverRange), findings model,
      `buildFederationGraph`. No repack/rspack imports (lint-enforced).
- [ ] T5. Port adapters (Re.Pack-specific): workspace config reader
      (`repack-federation.json`), config introspection (feature scan / extractShared
      from #1466), manifest sources (file/url/dev-server).
      DECISION 2026-09-29 (owner): buildFederationGraph lives in `src/core/graph.ts`
      (agnostic, per PRD G5); `src/studio/` only serves/renders it.
      DEFERRED to T7 with init/plan/apply (#1466): `resolveFederationWorkspace`
      (CLI-flag precedence merge), `assertStandaloneSupported`, and
      config-evaluation `extractShared`/dry-run — they load user rspack configs
      in-process, out of scope while introspection is the opt-in-plugin path
      (PRD §16.3). Typed seams already in place: core ports + `isUrlSource`.
- [ ] T6. Fixture workspace: host + 2 mini-apps (Rspack, MF2, no UI) +
      broken variants one per finding (remote-cycle, version-drift,
      missing-native), each with README + expected exit code.
- [ ] T7. CLI: bin `atlas` (name per T0) with `doctor`, `inspect`, `init`
      (init = port of #1466 dry-run/plan/apply, may lag), `--json`, exit codes
      0/1/2. Node integration tests spawn the bin against fixtures.
- [ ] T8. Studio: `graph.ts` + `server.ts` (node:http 127.0.0.1, `/`,
      `/api/graph`, SSE) + `page.ts` port of the mock (offline, textContent-only)
      + Playwright e2e incl. XSS fixture.
- [ ] T9. Runner: supervisor port of #1467 (start workspace, keymap incl. `v`,
      ports, `--json` events, `--studio-port`/`--no-studio`), ProcessRunner port.
- [ ] T10. CI: ci.yml (lint+typecheck, agent-files check, vendored-provenance,
      tests macOS+Linux Node LTS×2, studio-e2e), pr-checks.yml (conventional
      title, 400-line budget, linked issue). Actions pinned by SHA.
- [ ] T11. Docs: README (what/quickstart/fixtures), CONTRIBUTING.md, AI_POLICY.md.

## Verification

- `pnpm lint` / `pnpm typecheck` / `pnpm test` green locally and (when CI exists) in Actions.
- `node dist/cli.js doctor --fixtures fixtures/fixture-version-drift ... --json`
  → exit 1 with the drift finding; clean fixture → exit 0. (real output recorded)
- `scripts/agent-sync --check` green.
- Playwright studio suite green.

## Progress log

- 2026-09-29: PRD written; feature doc created; nothing ported yet.

## Progress log

- 2026-09-29: T1+T2 done (delegated writer + parent spot-check): scaffold with
  eslint fences (bridge-fence, core-boundary) proven to fire; agent-sync script
  with --check; 4 day-1 skills + symlinks; AGENTS.md/CLAUDE.md. Lint/typecheck/
  build/test green (1 smoke test). Note: fences use no-restricted-imports
  patterns (resolution-based rule silently no-ops with NodeNext .js specifiers).
- 2026-09-29: T3 done (delegated writer + parent spot-check): 6 files vendored
  from repack@c5df67f0 plugins/federationManifest (closed import graph — only
  external dep is a type-only @rspack/core import, swapped for bridge-owned
  structural types in rspack-compiler.ts). Upstream has NO per-file MIT headers
  (added, allowed by skill) and NO standalone plugin class (FederationManifestPlugin
  is an Atlas wrapper in repack-bridge/plugin.ts, exported as
  `repack-atlas/plugin` for the demo story). A3: three type-only strict-TS
  annotation fixes, no logic edits — all in VENDORED.md. core/manifest-types.ts
  holds independent structural schema types (bridge adapts via toCoreManifest).
  resolveRepack via createRequire, actionable error when absent. Bridge-fence
  probe re-verified. build/typecheck/lint/test green (9 tests).
- 2026-09-29: T4 done: core = doctor rules + semverRange + exit-codes + inspect
  formatting + NEW REMOTE_CYCLE (Tarjan, deterministic) + ports (interfaces only).
  38 upstream tests ported, 13 added (60 total). buildFederationGraph deferred
  to T8/studio per layout decision.
- 2026-09-29: T5 done (delegated writer + parent spot-check): src/adapters =
  ProjectFs, ProcessRunner (detached group + kill-tree, portPlanner probe port),
  manifest sources (file/url/dev-server, timeout+size cap, 404→missing / 5xx→
  corrupt), WorkspaceConfigReader (walk-up ported from configFile.ts),
  ConfigIntrospector reader + `repack-atlas/introspection` opt-in plugin writer.
  Pure configFile parts (schema, validator, describeJsonParseFailure) ported to
  src/core/federation-config.ts; ports for ProjectFs/ProcessRunner/
  ConfigIntrospector added to core/ports.ts (interfaces only). New lint block
  `atlas/adapter-boundary` (adapters may not import bundler packages directly —
  probe proven). Upstream configFile fixtures copied (tests/fixtures/adapters).
  59 tests added (119 total). extractShared/dryRun/resolveFederationWorkspace/
  assertStandaloneSupported deferred to T7 (config evaluation = init surface).
