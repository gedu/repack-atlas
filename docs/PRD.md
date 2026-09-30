# Repack Atlas — Product Requirements Document

> Status: DRAFT for review (2026-09-29). Owner: edug. Repository: `gedu/repack-atlas`.
> This document is also intended as Callstack's reference example of an
> "AI-ready project anyone can clone and contribute to, guided for any agent".

---

## 1. What this is

**Repack Atlas** is local developer tooling for React Native **Module Federation
workspaces** built with [Re.Pack](https://re-pack.dev). It answers, in seconds and
without a simulator:

- *What is my federation setup?* — a live graph of host + mini-apps, who exposes
  what, who consumes it, shared versions, native modules.
- *Is it correct?* — a doctor that finds shared-version drift, singleton/eager
  mismatches, circular remotes, and native modules the host does not declare.
- *Can I run it?* — an interactive dev runner that starts the whole workspace,
  and a read-only **Federation Studio** page served by the runner.

It started as three stacked PRs inside core Re.Pack —
[#1463](https://github.com/callstack/repack/pull/1463) (manifest + inspect + doctor,
+4.6k), [#1466](https://github.com/callstack/repack/pull/1466) (workspace tooling,
+12k), [#1467](https://github.com/callstack/repack/pull/1467) (dev runner, +17.5k).
The Re.Pack maintainers concluded this is **workspace tooling, not bundler scope**,
and cannot keep up reviewing it. Atlas extracts that tooling into its own repo;
core Re.Pack keeps only small enabling changes (§8).

## 2. Problem and users

### The problem (verified in core Re.Pack code, 2026-09)

- `requiredVersion` defaults to `'*'` in `ModuleFederationPluginV1.ts:194` and
  `ModuleFederationPluginV2.ts:209`; **nothing ever compares host vs remote
  versions**. Drift surfaces only as runtime crashes (repack issues #1367, #1368,
  #1428).
- Native-module compatibility between host and remotes is documented in one
  sentence and enforced by nothing.
- `shared` config blocks are duplicated by hand across every app; `eager`
  conventions are social, not code.
- Federation truth is spread across N `rspack.*.mts` files in N repos. New
  developers cannot see the system; wrong wiring shows up as a crash at runtime.

The base primitive already exists on the `feat/federation-manifest` branch
(commit `c5df67f0`): a machine-readable `repack-federation-manifest.json` emitted
at build time, schema-compatible with the upstream
[MF2 manifest specification](https://github.com/module-federation/core/blob/main/arch-doc/manifest-specification.md)
plus a `reactNative` extension block. Everything in Atlas consumes that manifest.

### Users

| User | Job to be done |
|---|---|
| RN dev in a super-app workspace | "Why does remote X crash / render the wrong version?" See the graph, run the doctor. |
| Platform engineer (multi-repo) | CI gate: `repack-atlas doctor --json` against deployed manifests of every app. |
| New team member | `repack-atlas dev`, press `v`, understand the whole federation in one page. |
| AI agents (Claude Code, Codex, Apex/OpenCode, Cursor, Copilot) | Clone, read `AGENTS.md`, load skills, run fixtures in seconds, contribute. |
| Re.Pack maintainers / Callstack | Evaluation candidate for the Callstack incubator; the AI-ready repo reference. |

## 3. Goals and non-goals

### Goals

1. **G1 — Vision**: read-only Studio graph of the workspace (apps, edges, shared,
   natives, doctor findings), served locally by the runner, zero deployment.
2. **G2 — Correctness**: `repack-atlas doctor` as a CI gate with stable exit codes and
   `--json` (report export; the answer to MF Devtools' "Report export").
3. **G3 — DX**: `repack-atlas init` (single-source shared config, plan/apply), `repack-atlas dev`
   interactive runner with equal non-interactive flags.
4. **G4 — AI-ready repo**: one instructions source (`AGENTS.md`), agentskills.io
   skills in `.agents/skills/`, adapters for Claude Code / Codex / Apex / Cursor /
   VS Code, sync script enforced in CI (§10). This is a first-class product goal,
   not internal plumbing: the repo is Callstack's clone-and-contribute reference.
5. **G5 — Separable core**: bundler-agnostic domain logic (graph, cycles, drift —
   they read standard MF2 `mf-manifest.json` shapes) with zero RN/Re.Pack types,
   so a web adapter could be added later without a rewrite.

### Non-goals

- **No config editing, ever** (Studio is read-only by design; see §7.3).
- **No web support now.** RN-first, Re.Pack-specific for now. But RN types must
  never leak into the agnostic core (§6.1).
- **Not a bundler.** No build behaviour changes; Atlas only observes configs and
  manifests.
- **Not a replacement for core Re.Pack's manifest plugin** — that stays upstream
  (§8).
- **No npm publish until the incubator decision** (§13).
- **No dependence on external device clouds**: tester.army/e2e is pre-release
  (waitlist) — optional later only.

## 4. Prior art: official Module Federation Devtools

Source: <https://module-federation.io/guide/debug/chrome-devtool> (verified
2026-09-29). It is a Chrome extension for **web** Module Federation and
**explicitly does not support React Native**. We borrow its information design
and adapt it to RN + static analysis. Atlas works from configs and manifests, so
it also works headless in CI — something the browser extension cannot do.

| Feature | MF Devtools (web) | Repack Atlas | Phase |
|---|---|---|---|
| Dependency Graph | runtime, browser | **static**, from manifests; works in CI and RN | 1 |
| Module Info (exposes, assets) | runtime | from manifest `exposes[]` + "Copy snippet" for unexposed files | 1 |
| Shared (singleton / strictVersion / versions) | runtime | from manifest `shared[]` with **resolved versions** + doctor drift findings | 1 |
| Native modules / platform | n/a (web) | **RN-only differentiator**: `reactNative.nativeModules`, new-arch, platforms | 1 |
| Doctor findings (cycles, drift, missing natives) | partial (version warnings) | `REMOTE_CYCLE`, `SHARED_VERSION_DRIFT`, `MISSING_NATIVE_MODULE`, … with exit codes | 1 |
| Proxy (point a remote at a local server / version / URL) | yes | candidate: remote override via the runner / Re.Pack resolver — **evaluate in this PRD review** | open |
| Loading Trace (why a remote failed / loaded unexpected version) | yes (runtime plugin) | later: runtime plugin in app reporting to the runner (needs in-app code) | 3+ |
| Report export | JSON download | `repack-atlas doctor --json` + exit codes (CI-native) | 1 |
| WebMCP (page → agent tools) | yes | **MCP server** exposing graph + findings to agents — candidate, evaluate | open |
| Platform support | browsers only | **React Native (Re.Pack/Rspack/MF2)** | — |

## 5. Delivery phases and acceptance criteria

### Phase 1 — Demo

Vendor Re.Pack code behind the bridge, build Studio + CLI, demo on a fork of
[callstack/super-app-showcase](https://github.com/callstack/super-app-showcase)
(host + auth/wallet/trading + sdk, Re.Pack + Rspack + MF2, active; **no changes
sent upstream**).

**Acceptance:**

- [ ] `git clone && pnpm install && pnpm test` green on macOS/Linux CI **without a
      simulator**, in under ~2 minutes; fixture doctor suite in seconds.
- [ ] On the showcase fork: one command starts host + ≥2 remotes; pressing `v`
      opens the Studio showing every app, live status, consumption edges, and all
      doctor findings; page updates within ~1 s after a rebuild.
- [ ] `repack-atlas doctor --json` catches each broken fixture variant (remote cycle,
      version drift, missing native module) with the correct exit code, in CI.
- [ ] Bridge lint rule passes: nothing outside `src/repack-bridge/` imports
      `vendored/`; `VENDORED.md` lists every vendored file with source path +
      commit (`c5df67f0`) and keeps MIT headers.
- [ ] Studio page is self-contained HTML (no CDN, works offline), renders manifest
      strings only via `textContent` / SVG text nodes.
- [ ] Base standards from day 1: `AGENTS.md`, `CLAUDE.md` one-liner, ≥ the core
      skills (§10.4) with the sync script + CI check, Conventional Commits,
      no AI attribution in commits.

### Phase 2 — Public, contributor-ready repo

**Acceptance:**

- [ ] README with demo GIF; quickstart against a fresh showcase clone.
- [ ] Full skills catalog (§10.4) + contribution guides (`CONTRIBUTING.md`,
      `AI_POLICY.md` adapted from
      [gentle-ai's](https://github.com/Gentleman-Programming/gentle-ai/blob/main/AI_POLICY.md)).
- [ ] CI matrix (macOS + Linux, Node LTS ×2) including fixture tests; Windows
  *attempted* — see risk R6 (symlinks).
- [ ] Skill-sync CI check fails if any skill is missing an adapter link or an
      `AGENTS.md` catalog row (§10.3).
- [ ] One external contributor can go issue → PR → green CI using only repo files.
- [ ] `VENDORED.md` cost tracked: the swap plan (§8.2) has a dated owner per
      vendored block.

### Phase 3 — Incubator transfer

**Acceptance:** GitHub transfer to `callstack/` (easy); npm publish decision made
the first time (the hard part — §13); Loading Trace and/or Proxy/MCP candidates
promoted or explicitly dropped; core Re.Pack enabling PRs merged or closed with a
decision recorded in `docs/decisions/`.

## 6. Architecture

### 6.1 Hexagonal: domain / ports / adapters

```
                       ┌───────────────────────────────────────────┐
  CLI (repack-  ─────►│ adapters/                                  │
  atlas …)            │                                            │
  Studio server ─────►│  repack-adapter · cli · studio-server ·     │
  runner keys   ─────►│  dev-runner · (mcp-server, later)           │
                       │        │ ports (interfaces only)           │
                       │        ▼                                   │
                       │ core/  (bundler-agnostic domain)           │
                       │  graph model · cycle detection ·           │
                       │  drift analysis · findings · manifest      │
                       │  schema types (MF2-compatible)             │
                       └───────────────────────────────────────────┘
```

- **`src/core/`** — pure functions over plain JSON: `buildFederationGraph(config,
  manifests, findings)`, Tarjan/DFS cycle detection, shared-drift comparison,
  finding types. It reads the standard MF2 `mf-manifest.json` field shapes
  (`shared[]`, `remotes[]`, `exposes[]`, `metaData`); the Re.Pack manifest is a
  superset, so core never learns about Re.Pack. **No RN types, no Re.Pack imports,
  no rspack imports — enforced by lint (import boundaries), not by review.**
- **Ports** (interfaces owned by core): `ManifestSource` (file | URL | dev-server),
  `WorkspaceConfigReader` (`repack-federation.json`), `ProjectFs` (the user
  project's filesystem — tests run on fixtures), `ProcessRunner` (spawning bundlers
  / metro / xcodebuild), `ConfigIntrospector` (load a user rspack config and
  extract federation options).
- **Adapters** implement ports against real things and are the only code allowed to
  touch the outside world. The dev runner serves Studio via `node:http` on
  `127.0.0.1` (the supervisor is the only process that knows the whole workspace;
  the repack dev-server has no sanctioned route extension point —
  `packages/dev-server/src/createServer.ts:123-142` on the fork).

### 6.2 The repack bridge (vendor → swap)

Re.Pack's `package.json` ships a strict `exports` map (`.`, `./client`,
`./commands`, `./commands/*`, `./mf/*`, loaders, `./package.json`); deep
`dist/...` imports throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. That, plus the fact that
the tooling code is still unmerged upstream, is why the demo **vendors** instead
of waiting.

```
src/repack-bridge/
├── index.ts     # the ONLY import surface for the whole app
├── vendored/    # copied Re.Pack code, MIT headers intact
└── …            # thin wrappers: resolve repack from the USER project
VENDORED.md      # per file: upstream path + source commit (c5df67f0) + why vendored
```

Rules (lint-enforced):

1. Only `src/repack-bridge/index.ts` may import from `vendored/`. A lint rule
   (ESLint `no-restricted-imports` pathPattern or dependency-cruiser) fails CI
   otherwise.
2. Re.Pack is a **peerDependency** resolved from the user's project
   (Gradle-style node_modules walk):
   `createRequire(path.join(projectRoot, 'package.json'))`. Never resolved from
   Atlas's own tree.
3. Every vendored file records its source in `VENDORED.md` at copy time; updating
   vendored code is a deliberate, reviewed diff against upstream, not a silent edit.
4. **`index.ts` is the exports request.** When core exports what we need, we delete
   the vendored block, re-export from `@callstack/repack`, and the git diff of
   `index.ts` *is* the concrete list of exports core must add (§8.2).

### 6.3 The wrapper rule

Wrap what is **volatile or will be replaced**; do not wrap the stable world.

| Wrap (port + adapter) | Do not wrap |
|---|---|
| Re.Pack internals (bridge) | Node standard library |
| Rspack/webpack APIs (config loading/introspection) | Stable stateless utilities |
| Module Federation runtime surface | |
| The user project's filesystem (fixtures in tests) | |
| Process spawning (bundler, ports, simulators) | |

One adapter per wrapped thing, interface owned by core. This is what makes the
fixtures (§9) and the vendor→swap plan possible without rewrites.

## 7. Product surface

### 7.1 CLI commands

Flat commands registered through the React Native Community CLI plugin surface
(same pattern core Re.Pack uses for `federation-doctor`/`federation-manifest`:
a `commands` array exported via `react-native.config.js`; no `repack federation …`
subcommand tree). In the demo phase the same commands ship as an `repack-atlas` bin.

| Command | Purpose | Machine interface |
|---|---|---|
| `repack-atlas init` | Generate/repair `repack-federation.json` + single-source shared config from installed versions. Plan first, apply explicitly. | `--dry-run --json` |
| `repack-atlas inspect <path\|url>` | Pretty-print a federation manifest (file, build output, or URL). | `--json` |
| `repack-atlas doctor` | Compare host + remote manifests: drift, singleton/eager mismatch, `REMOTE_CYCLE`, missing natives, heuristic-honesty downgrades. | `--json`, exit codes below |
| `repack-atlas dev` | Interactive workspace runner (pick remotes, platforms, ports), equal non-interactive flags (`--ios --remotes wallet,trading --ci`); serves Studio. | `--json` events, incl. `{event:'studio', url}` |

Doctor exit codes (locked in the fork's design doc, kept here): `0` clean
(warnings allowed) · `1` drift — any error finding (`MISSING_REMOTE_MANIFEST`
unless `--allow-missing-manifests`) · `2` could not run — missing option, host
manifest missing/corrupt. `2` means "no answer", `1` means "bad answer"; CI
treats both as failure. Heuristic honesty is preserved: `dynamicImportDetected`
or `confidence: heuristic` downgrades missing-native findings to advisories —
Atlas reports what it cannot check instead of guessing.

### 7.2 Studio (served by the runner)

- `node:http` bound to **127.0.0.1 only**; `--studio-port` (default: first free
  from 8099); `--no-studio` disables.
- Routes: `GET /` (page), `GET /api/graph` (JSON), `GET /api/events` (SSE, pushes
  the graph on rebuild/status change).
- Page = one self-contained HTML string exported from a `.ts` module: vanilla JS +
  inline SVG, **no framework, no CDN, no webfonts — works offline**. Visual spec:
  Re.Pack brand tokens from the mock (`odd/reports/federation-studio-mock.html`
  in the repack fork): accent `#8232ff`/`#9b6dff`, logo gradient
  `#9b6dff → #3ce4cb`, light + dark via `prefers-color-scheme`, keyboard-focusable
  graph nodes, `prefers-reduced-motion` respected.
- Layout: top bar (title, URL, one pill per app with status dot + port); graph
  (1.55fr) + inspector (1fr, tabs Exposes / Shared / Native / Bundle); full-width
  doctor findings list with severity stripes; cycle edges dashed red.
- Manifests are fetched from each running dev server at the default
  `repack-federation-manifest.json` asset route (a custom `fileName` is not
  served by the repack dev-server allowlist).

### 7.3 Studio is read-only — forever

No write endpoints, no config editing, no checkboxes. Rationale (decided
2026-09-28): adding an `exposes` entry is the easiest part of MF config; exposing
a file publishes a public contract that old app versions keep loading;
editable-vs-read-only apps would create two sources of truth. Unexposed files get
a **"Copy snippet"** button (`navigator.clipboard.writeText` in the click handler,
select-text fallback) so the human pastes and commits.

**Security:** manifest content is untrusted input (can come from URLs). Render
with `textContent` / SVG text nodes only — never `innerHTML` with manifest
strings. Localhost bind only; no CORS beyond same-origin.

## 8. Relationship with core Re.Pack

### 8.1 What stays in core

1. **Federation manifest plugin** — `src/plugins/federationManifest/` + hooks in
   `ModuleFederationPluginV1/V2` (~2k lines of #1463). It must live where the
   compilation lives. Until it lands, **the demo adds the vendored manifest
   plugin to each app's rspack config** in the showcase fork.
2. **Dev-server `normalizeOptions` port fix** — its own small PR.
3. Everything else (#1466 workspace tooling, #1467 runner, Studio) moves here;
   those PRs are expected to close in favour of Atlas + enabling changes.

### 8.2 The exports request (vendor → swap)

`src/repack-bridge/index.ts` is written as if the exports already existed. When
core lands them, each vendored block is replaced by a re-export in one commit.
Expected request shape (finalised when the bridge is real, this is the forecast):

- stable manifest **types + schema** (or rely on the published MF2 manifest spec),
- a **config-introspection** hook or documented way to read federation options
  from a user config without deep-importing internals,
- **dev-server asset-route** guarantee for the manifest filename,
- the `normalizeOptions` port fix.

Trade-off accepted: during the vendor window there are two copies of ~a few
thousand lines. Mitigations: `VENDORED.md` provenance, lint fence, small vendored
surface (only what the demo needs), and the swap being a mechanical diff.

## 9. Testing strategy

| Layer | What | How |
|---|---|---|
| Unit | core domain (graph, cycles, drift), pure functions, fixtures on disk | Node test runner + TS; every doctor finding code has fixture tests |
| CLI integration | spawn the built bin against fixture workspaces, parse `--json`, assert exit codes | Node integration tests — no simulators, seconds to run |
| Fixture workspace | `fixtures/workspace/`: host + 2 mini-apps, Rspack, MF2, no real UI. Broken variants, **one per doctor finding**: `fixture-remote-cycle/`, `fixture-version-drift/`, `fixture-missing-native/` | The wrapper rule's `ProjectFs`/`ProcessRunner` ports are what make this possible |
| Studio e2e | Playwright against a runner started on fixtures; deterministic (fixed ports, injected clocks) | CI, headless Chromium |
| Mobile e2e | optional, later; real device run on the showcase fork | tester.army/e2e is waitlist — never a CI dependency |

Conventions: behaviour changes land with a failing test first where the TDD loop
is practical; every fixture variant carries a `README.md` stating which finding it
provokes and the expected exit code, so agents can self-serve.

## 10. Multi-agent setup (the AI-ready reference)

### 10.1 One source of truth

| Artifact | Role |
|---|---|
| `AGENTS.md` (repo root) | The **only** instructions file. Skills index table + hard rules + setup + checks. |
| `CLAUDE.md` | One line importing `AGENTS.md`. |
| `.agents/skills/<name>/SKILL.md` | Canonical skills, [agentskills.io](https://agentskills.io) format (`name`, `description` frontmatter; optional `references/`, `scripts/`, `assets/`). |
| `.claude/skills/<name>` | **Symlinks** to `.agents/skills/<name>` (the pattern core Re.Pack already uses for `upgrade-react-native`). |
| `scripts/agent-sync.(sh\|ts)` | Creates/repairs the adapters; `--check` mode used by CI. |
| Every skill the project needs or uses lives in the repo. | |

### 10.2 What each agent reads (verified 2026-09-29, primary sources)

| Agent | Instructions | Skills | Adapter needed |
|---|---|---|---|
| **Codex / OpenAI** | `AGENTS.md` natively: global (`~/.codex`) then root→CWD nesting, one file per dir, merged root-down, 32 KiB cap (`project_doc_max_bytes`). <br/><https://developers.openai.com/codex/agent-configuration/agents-md> | Reads `.agents/skills/` natively (repo root → CWD walk-up, `~/.agents/skills`, symlinks followed). <br/><https://developers.openai.com/codex/build-skills> | none |
| **Claude Code** | `CLAUDE.md` | `.claude/skills/` (does not read `.agents/skills` on its own) | `CLAUDE.md` one-liner + symlinks |
| **Apex** (`@callstack/apex`, OpenCode-based) | OpenCode rules file support incl. `AGENTS.md` | OpenCode reads `.opencode/skills`, `.claude/skills` **and** `.agents/skills` (project + `~/.claude/skills`, `~/.agents/skills`). <br/><https://opencode.ai/docs/skills> — name must match dir, `^[a-z0-9]+(-[a-z0-9]+)*$`, description ≤ 1024 chars | none beyond canonical layout |
| **Cursor** | Reads `AGENTS.md` (root + nested subdirs). <br/><https://cursor.com/docs/rules> | `.agents/skills/` and `.cursor/skills/` natively (also `.claude/skills`, `.codex/skills` for compatibility). <br/><https://cursor.com/docs/skills> | none |
| **VS Code / Copilot** | `AGENTS.md` supported (setting `chat.useAgentsMdFile`; `.github/copilot-instructions.md` is the Copilot-native file). <br/><https://code.visualstudio.com/docs/agent-customization/custom-instructions> | `.github/skills/`, `.claude/skills/`, `.agents/skills/` (project); `name` must match dir name. <br/><https://code.visualstudio.com/docs/agent-customization/agent-skills> | none |

**Conclusion:** `.agents/skills/` + root `AGENTS.md` covers Codex, Cursor, VS Code,
and Apex/OpenCode natively. Only Claude Code needs adapters (`CLAUDE.md` line +
`.claude/skills` symlinks). `.github/copilot-instructions.md` → symlink of
`AGENTS.md` is optional (prowler does it; VS Code reads `AGENTS.md` directly) —
decision: skip it, add only if users report gaps.

### 10.3 Sync script and CI guard

Copy the prowler pattern, simplified ([prowler/skills/setup.sh](https://github.com/prowler-cloud/prowler/blob/master/skills/setup.sh), [prowler/skills/skill-sync](https://github.com/prowler-cloud/prowler/tree/master/skills/skill-sync)):

- `agent-sync` (re)creates `.claude/skills/<name>` symlinks for every
  `.agents/skills/<name>`, and regenerates the skills table in `AGENTS.md` from
  each SKILL.md's frontmatter (`name`, `description`, and a
  `metadata.auto_invoke` action list — prowler's key insight: agents do not
  reliably auto-invoke skills from descriptions alone, so `AGENTS.md` carries an
  explicit "When doing X, ALWAYS load skill Y first" table).
- CI runs `agent-sync --check`: fails if a skill lacks its symlink, the `AGENTS.md`
  table drifted, or a SKILL.md fails validation (name/dir match, description
  length, frontmatter fields per the OpenCode/VS Code constraints above).

### 10.4 Skills catalog (day-1 core marked ★, rest land by phase 2)

| Skill | Purpose | Trigger (goes in `description`) |
|---|---|---|
| `atlas-dev-setup` ★ | Clone → install → run fixture demo in seconds; the fastest "it works" path. | "set up, install, run, or debug this repo locally" |
| `atlas-bridge-vendoring` ★ | Add/update/remove vendored code safely: VENDORED.md protocol, lint fence, peerDependency resolution, swap procedure. | "touching src/repack-bridge/, vendored/, or the exports swap" |
| `atlas-doctor-finding` ★ | Add a new doctor finding end-to-end: code, fixture variant, `--json` shape, exit code, docs, test. | "adding or changing a doctor check/finding" |
| `atlas-studio` | Change Studio safely: read-only rule, untrusted-render rule, visual tokens, page.ts structure, Playwright update. | "touching studio/, page HTML, or graph rendering" |
| `atlas-runner` | Dev-runner changes: supervisor lifecycle, keymap, ports, SSE, `--json` events. | "touching the dev runner or its flags/keys" |
| `atlas-fixtures` | Create/repair fixture workspaces and broken variants; keep the "runs in seconds" budget. | "fixtures/ changed or a finding lacks a fixture" |
| `agent-skills-sync` ★ | After creating/modifying any skill, run the sync script and the checks (prowler's `skill-sync` equivalent). | "after creating or modifying a skill; skill missing from AGENTS.md table" |
| `work-unit-commits` | Plan commits as reviewable work units (tests+docs with behaviour). | "splitting implementation into commits/PR slices" |
| `branch-pr` | Branch + PR conventions for this repo (issue link, template, checks). | "creating or preparing a PR" |
| `chained-pr` | Split >400-line changes into chained PRs. | "change too large for one review" |
| `mf-manifest-spec` | The manifest schema contract: field-by-field reference + upstream MF2 alignment rules. | "changing manifest types or schema" |

Portable writing/work-unit skills keep canonical names (gentle-ai convention);
repo skills are prefixed `atlas-`.

### 10.5 Patterns borrowed — and not

From [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai): ✅ skills
index table in `AGENTS.md` with triggers+paths; ✅ `AI_POLICY.md` (human owns the
submission; disclose material AI help; **no `Co-Authored-By` AI trailers**); ✅
400-line PR review budget with a maintainer `size:exception` escape hatch; ✅
issue-first ("no PR without an approved issue"). ❌ Not its CI machinery
complexity (rulesets + label contracts + baseline ratchets tuned for a large Go
project) — we keep the same *rules* with an order of magnitude less enforcement
code, revisit at incubator.

From [prowler](https://github.com/prowler-cloud/prowler): ✅ `AGENTS.md` as the
single source + explicit **Auto-invoke** table; ✅ skill metadata driving a sync
script; ✅ per-tool symlinks; ✅ nested `AGENTS.md` idea if `studio/` or
`fixtures/` ever need local rules. ❌ Not syncing AGENTS.md into *copies* per tool
(prowler's setup.sh writes/copies several files) — copies drift; we use imports
and symlinks only.

## 11. Contribution workflow

1. **Issue-first.** Open an issue (bug/feature template); work starts when a
   maintainer applies `status:approved`. `up-for-grabs` marks approved, unclaimed
   work.
2. Branch from `main`, Conventional Commits
   (`feat|fix|docs|test|chore(scope): imperative summary`).
   **Never** add AI attribution or `Co-Authored-By` trailers.
3. Work units: each commit is a reviewable unit with its tests and docs.
4. PRs ≤ **400 changed lines** (additions+deletions); above that, split into
   chained PRs or a maintainer-approved `size:exception`.
5. PR links an approved issue (`Closes #N` or `Refs #N`); one `type:*` label.
6. CI must be green (§12) and the contributor must be able to explain every line
   (AI_POLICY). Report actual check output; never claim a check passed without
   running it.

## 12. CI

Single `ci.yml` + `pr-checks.yml` to start:

- **lint + typecheck** — ESLint (incl. the bridge fence and core-boundary import
  rules), `tsc --noEmit`.
- **Agent files sync check** step — `pnpm agent:check` (`agent-sync --check`): every `.agents/skills/*` has its
  `.claude/skills` symlink, `AGENTS.md` table in sync, SKILL.md frontmatter valid
  (name/dir match, description bounds).
- **Vendored provenance check** step — `pnpm check:vendored`: every file under `vendored/` appears in `VENDORED.md`
  with a commit SHA; fail otherwise.
- **test** — unit + CLI integration (fixture workspaces) on macOS + Linux,
  Node LTS ×2.
- **studio-e2e** — Playwright (headless Chromium) against fixtures.
- PR gates: conventional-commit title check, size check (400-line budget),
  linked-issue check.

No publishing workflows exist until phase 3. Actions pinned by SHA (prowler
pattern); no `pull_request_target` with write tokens.

## 13. Naming, release and publishing policy

- Working name **Repack Atlas** (repo `repack-atlas`). Earlier candidates
  (`federation-studio`, `super-app-devtools`, `mf-atlas`) are superseded by the
  repo that exists — but see risk R5 ("Atlas" collides with the React Native
  *Atlas* build-system name; confirm before public launch).
- **No npm publish until the incubator decision.** A scope rename later means a
  new package + deprecating the old one; the GitHub transfer itself is trivial.
- During phases 1–2 consumers install from git (`npm i github:gedu/repack-atlas`
  / `pnpm` equivalent). Versions via changesets from day 1 (release lines are
  cheap to have honest), `CHANGELOG.md` generated, first npm publish is a tagged
  decision in phase 3.
- License: MIT (already in repo); vendored files keep upstream MIT copyright
  headers and are inventoried in `VENDORED.md`.

## 14. Conventions

- **Language**: all artifacts (code, comments, docs, UI copy, commit messages) in
  English.
- Conventional Commits; no AI attribution trailers (AI_POLICY).
- Determinism everywhere user-visible: every command has non-interactive flags
  mirroring interactive flows, human output by default, `--json` for machines,
  messages that name the package and the conflicting versions.
- Honest heuristics: anything static-analysis-derived declares its confidence
  (`static` vs `heuristic`); the product never claims exhaustive guarantees it
  cannot make.
- Errors exit non-zero with actionable messages; `2` = "could not answer",
  `1` = "answer is bad".

## 15. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Vendored code drifts** from repack while upstream evolves (or the exports request never lands). | Small vendored surface; VENDORED.md + CI provenance check; bridge index = the ask, tracked as a public checklist; monthly re-evaluation vs repack `main`. |
| R2 | Demo depends on unmerged core changes (manifest plugin). | Demo ships the vendored manifest plugin in showcase configs; swap when the core PR lands; if core rejects it permanently, the plugin becomes a supported Atlas package (decision point recorded). |
| R3 | **Maintainer bandwidth** repeats here (this repo started for that reason). | 400-line PR budget, skills that automate review-relevant conventions, small surface, one reviewer max per PR by design. |
| R4 | Manifest is **untrusted input** (XSS via Studio). | textContent/SVG-text-only rule + Playwright XSS fixture (manifest containing `<script>` renders as text). |
| R5 | Name collision: "Atlas" is also RN's known build-system codename. | Confirm naming before public launch; alternatives reserved on npm/GitHub per 2026-09-29 check. |
| R6 | **Windows**: `.claude/skills` symlinks and dev-port assumptions. | CI is macOS+Linux first; document Windows fallback (run `agent-sync` with `--copy` or Developer Mode); no Windows-only promises in phase 1. |
| R7 | Runner spawns bundlers across platforms (ports, signals, shells). | `ProcessRunner`/port-alloc ports with unit tests; integration tests spawn real fixture processes on CI. |
| R8 | Scope creep back into bundler territory. | Non-goal §3 restated in AGENTS.md; anything touching compilation = core Re.Pack proposal, not an Atlas PR. |

## 16. Open questions — resolved 2026-09-29 where marked

1. **[RESOLVED] Binary/CLI naming**: bin is **`repack-atlas`** (full name, no
   `atlas` shortcut, to avoid confusion with the RN Atlas build system).
   RN-CLI commands keep the fork's flat names (`federation-doctor`,
   `federation-manifest`) when registered via `react-native.config.js`.
2. **[RESOLVED] Proxy and MCP server**: deferred; candidates for phase 3.
3. **[RESOLVED] Config introspection**: demo requires a small Atlas plugin in
   user configs (robust, explicit opt-in step); revisit in-process loading for
   `init` UX later.
4. **[RESOLVED] Node floor**: `>=20` (repack core says `>=18` but Node 18 is
   EOL; repack's own workspace runs `>=24`).
5. Demo recording venue for README GIF (showcase fork needs simulator; record is
   local, not CI).

---

## Appendix A — Sources consulted (all primary, verified 2026-09-29)

- Re.Pack fork: branch `feat/federation-manifest` @ `c5df67f0`; design doc
  `agent_context/federation-tools/design.md`; PRs callstack/repack #1463 (open,
  +4,625), #1466 (open, +11,994), #1467 (open, +17,469) via `gh pr view`.
- Federation Studio plan v3 + handoff (Engram `repack/federation-studio/plan`,
  `repack/federation-studio/handoff`); mock
  `odd/reports/federation-studio-mock.html`.
- MF Devtools: <https://module-federation.io/guide/debug/chrome-devtool>
- MF2 manifest spec: <https://github.com/module-federation/core/blob/main/arch-doc/manifest-specification.md>
- Codex AGENTS.md: <https://developers.openai.com/codex/agent-configuration/agents-md>
- Codex skills: <https://developers.openai.com/codex/build-skills>
- Cursor rules/AGENTS.md: <https://cursor.com/docs/rules>
- Cursor skills: <https://cursor.com/docs/skills>
- VS Code custom instructions: <https://code.visualstudio.com/docs/agent-customization/custom-instructions>
- VS Code agent skills: <https://code.visualstudio.com/docs/agent-customization/agent-skills>
- OpenCode skills (Apex base): <https://opencode.ai/docs/skills>
- Apex CLI readme (`npx @callstack/apex init` behaviour): npm registry `@callstack/apex@0.2.2`
- gentle-ai: `AGENTS.md`, `skills/`, `AI_POLICY.md`, `CONTRIBUTING.md`, `pr-size-policy.yml`
- prowler: `AGENTS.md`, `skills/README.md`, `skills/setup.sh`, `skills/skill-sync`, PR #9751 (skill-sync rationale)
