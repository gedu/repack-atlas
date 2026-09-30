# Repack Atlas — Agent Instructions

Local developer tooling for React Native Module Federation workspaces built with
Re.Pack: a static federation graph, a correctness doctor, and a read-only dev
runner + Studio — no simulator required.

## Hard rules

These are enforced by lint/CI where marked; a PR that weakens a guard to pass a
check will be closed.

1. **Vendored fence.** Nothing outside `src/repack-bridge/**` may import
   anything under `**/vendored/**` (ESLint `atlas/bridge-fence`). Vendored
   Re.Pack code needs a `VENDORED.md` entry and intact MIT headers
   (upstream `callstack/repack`, branch `feat/federation-manifest`, commit
   `c5df67f0`). `src/repack-bridge/index.ts` is the only import surface.
2. **Core boundary.** `src/core/**` is bundler-agnostic: no imports from
   `src/repack-bridge/**`, `src/adapters/**`, `@callstack/repack`,
   `@module-federation/*`, `@rspack/*`, or `webpack` (ESLint
   `atlas/core-boundary`). Core talks to the world through ports it owns.
3. **Wrapper rule.** Wrap what is volatile or will be replaced (Re.Pack
   internals, rspack/webpack APIs, the user project's filesystem, process
   spawning) behind a core-owned port plus one adapter. Do not wrap the Node
   standard library or stable stateless utilities.
4. **Re.Pack resolution.** `@callstack/repack` is a peerDependency resolved from
   the **user project** via
   `createRequire(path.join(projectRoot, 'package.json'))` — never from Atlas's
   own tree.
5. **Studio is read-only, forever.** No write endpoints, no config editing.
   Manifest content is untrusted: render with `textContent` / SVG text nodes
   only, never `innerHTML`. Server binds `127.0.0.1` only; page is
   self-contained (no CDN, works offline).
6. **Exit codes.** `0` clean (warnings allowed) · `1` ran and found errors ·
   `2` could not answer. `1` and `2` must stay distinguishable; CI treats both
   as failure.
7. **Honest heuristics.** Static-analysis findings declare `confidence:
   static | heuristic`; heuristic results downgrade to advisories. Never claim
   exhaustive guarantees.
8. **Conventional Commits.** `feat|fix|docs|test|chore(scope): imperative
   summary`. **Never** add AI attribution or `Co-Authored-By` trailers.
9. **Report real output.** Paste the actual command output for every check you
   claim passed. A claimed check without observed output is a failed check.
10. **English artifacts.** All code, comments, docs, UI copy and commits in
    English. Every skill the project needs lives in this repo.

Full rationale: `docs/PRD.md` (§6 architecture, §10 multi-agent setup, §14
conventions).

## Setup

```bash
pnpm install     # Node >= 22.13, pnpm >= 10
pnpm build       # tsc: src -> dist
pnpm typecheck   # tsc --noEmit over src + tests (+ tests/e2e with DOM lib)
pnpm lint        # eslint incl. both architectural fences
pnpm test        # node:test via tsx (fixtures run in seconds, no simulator)
pnpm test:e2e    # Playwright + chromium over the Studio preview (needs the
                 # browser: pnpm exec playwright install chromium)
pnpm agent:sync  # regenerate skill symlinks + AGENTS.md tables
pnpm agent:check # CI-mode verification of the above (exit 1 on drift)
pnpm check:vendored # CI: every vendored file in VENDORED.md with a commit
                 # sha + Copyright header (exit 1 on drift)
```

CI (`.github/workflows/ci.yml`) is light: lint, typecheck, build, test,
`agent:check` and `check:vendored` in one Linux / Node 22 job per PR. The full
matrix (macOS + Linux × Node 22/24) and the Playwright studio-e2e job live in
`ci-full.yml` and run only when a maintainer adds the `ready-to-merge` label
(or via `workflow_dispatch`). PR gates (title, 400-line budget, linked
issue) live in `pr-checks.yml`. Reproduce every job locally with the commands
above; CONTRIBUTING.md maps each CI step to its command.

## Layout

```
src/
├── cli.ts               # `repack-atlas` bin: argv → adapters+core → exit code
├── cli/                 # bin internals: arg parser, help, doctor plan, init plan
├── core/                # bundler-agnostic domain: manifest schema types,
│                        #   findings model, buildFederationGraph (core/graph.ts),
│                        #   cycle detection, shared-drift analysis, ports
│                        #   (interfaces only)
├── repack-bridge/       # the ONLY Re.Pack import surface
│   ├── index.ts         #   = the exports request (vendor -> swap)
│   ├── plugin.ts        #   `repack-atlas/plugin` subpath: FederationManifestPlugin
│   │                    #   wrapper the showcase app adds to its rspack config
│   └── vendored/        #   copied Re.Pack code, MIT headers, VENDORED.md
├── adapters/            # port implementations: workspace config reader,
│                        #   manifest sources, ProjectFs, ProcessRunner
├── studio/              # node:http server (127.0.0.1, GET-only) + page.ts +
│                        #   workspace graph loader; serves core/graph.ts output
└── runner/              # interactive dev runner (supervisor, keymap, SSE)
tests/                   # node:test suites (unit + CLI integration on fixtures)
tests/e2e/               # Playwright specs for Studio (own tsconfig with DOM lib)
playwright.config.ts     # boots tools/studio-preview.mjs on a fixed port
tools/                   # dev-only scripts, excluded from the build and package
fixtures/                # throwaway user workspaces, one broken variant per finding
docs/PRD.md              # source of truth
odd/                     # internal planning notes (not user docs)
VENDORED.md              # provenance ledger for src/repack-bridge/vendored/
.agents/skills/          # canonical skills (agentskills.io format)
.claude/skills/          # generated symlinks -> .agents/skills/*  (do not edit)
scripts/agent-sync.mjs   # generates the adapters + the tables below
scripts/vendored-check.mjs # CI provenance guard for VENDORED.md (pnpm check:vendored)
.github/workflows/       # ci.yml (light) + ci-full.yml (matrix + e2e) + pr-checks.yml
```

Direction of dependency: adapters → ports in core. Core never imports outward.

## Skills

<!-- BEGIN auto-generated skills table -->

| Skill | Trigger | Path |
|---|---|---|
| `agent-skills-sync` | Trigger: after creating or modifying a skill; skill missing from the AGENTS.md table; agent-files or agent-sync --check failing in CI; adding a new skill directory. | `.agents/skills/agent-skills-sync/SKILL.md` |
| `atlas-bridge-vendoring` | Trigger: touching src/repack-bridge/, src/repack-bridge/vendored/, or VENDORED.md; copying code out of Re.Pack; the exports swap; a bridge import fails with ERR_PACKAGE_PATH_NOT_EXPORTED. | `.agents/skills/atlas-bridge-vendoring/SKILL.md` |
| `atlas-dev-setup` | Trigger: set up, install, build, run, test, or debug this repo locally; "it does not build"; fresh clone; CI failing on a check you cannot reproduce locally. | `.agents/skills/atlas-dev-setup/SKILL.md` |
| `atlas-doctor-finding` | Trigger: adding or changing a doctor check or finding, a finding code such as REMOTE_CYCLE or SHARED_VERSION_DRIFT, the doctor --json output shape, or a finding that has no fixture yet. | `.agents/skills/atlas-doctor-finding/SKILL.md` |

<!-- END auto-generated skills table -->

Generated by `scripts/agent-sync.mjs` from each `SKILL.md` — do not edit between
the markers. Canonical skills live in `.agents/skills/`; only Claude Code needs
the `.claude/skills/` symlink adapter (run `pnpm agent:sync`, enforced by
`pnpm agent:check` in CI).

## Auto-invoke

Agents do not reliably load skills from descriptions alone, so load explicitly:

<!-- BEGIN auto-generated auto-invoke table -->

When performing the action on the left, ALWAYS load the skill on the right
before writing code.

| When performing | ALWAYS load first |
|---|---|
| creating or modifying any file under .agents/skills/ | `agent-skills-sync` |
| adding or renaming a skill directory | `agent-skills-sync` |
| fixing a failing agent-files CI job | `agent-skills-sync` |
| importing or copying any code from Re.Pack | `atlas-bridge-vendoring` |
| modifying src/repack-bridge/** | `atlas-bridge-vendoring` |
| removing a vendored block during the exports swap | `atlas-bridge-vendoring` |
| setting up this repo for the first time | `atlas-dev-setup` |
| reproducing a failing CI check locally | `atlas-dev-setup` |
| running the fixture test suite | `atlas-dev-setup` |
| adding a new doctor finding code | `atlas-doctor-finding` |
| changing an existing doctor rule or its severity | `atlas-doctor-finding` |
| changing the doctor --json report shape | `atlas-doctor-finding` |

<!-- END auto-generated auto-invoke table -->

Generated by `scripts/agent-sync.mjs` — do not edit between the markers.
