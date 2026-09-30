# Demo runbook — repack-atlas on super-app-showcase

A step-by-step guide for demoing repack-atlas to another developer using the
super-app-showcase workspace. Every command and output below was verified
against the real workspace; the "verified findings" are the actual numbers
from the demo run, not projections.

What the demo proves: a doctor, a graph, a supervised dev runner and a
read-only Studio working on a real multi-app Re.Pack Module Federation
monorepo — with a real federation config, real shared-dependency data and
real dev servers. No fixtures.

## 0. Prerequisites (one-time setup)

Two checkouts side by side:

```
<parent>/
├── repack-atlas/            # the tool (Node >= 22.13, pnpm >= 10)
└── super-app-showcase/      # the demo workspace (Node >= 24.18, pnpm 11)
```

1. Build the tool:

   ```bash
   cd repack-atlas && pnpm install && pnpm build
   ```

2. In the showcase fork (branch `atlas-demo`), the demo wiring is:
   - `repack-atlas` as a `file:../../../repack-atlas` devDependency of
     `packages/{host,auth,trading,wallet}`
     (commit `feat(deps): add repack-atlas as local file dependency`);
   - each app's `rspack.config.ts` adds two plugins next to
     `ModuleFederationPluginV2`:
     `FederationManifestPlugin` from `repack-atlas/plugin` with
     `{ manifest: true, writeToDisk: true, ...same shared/remotes/exposes }`
     and `IntrospectionPlugin` from `repack-atlas/introspection`;
   - `repack-federation.json` at the showcase root with the host + 3 remotes,
     file manifest refs, ports and start commands.
3. Install and warm up:

   ```bash
   cd ../super-app-showcase
   pnpm install          # snapshots the file: dep — re-run after tool rebuilds
   ```

4. Port map (from each app's `start` script; no collisions):

   | app      | port | start command             |
   |----------|------|---------------------------|
   | host     | 8081 | `pnpm --filter host start`    |
   | trading  | 9001 | `pnpm --filter trading start` |
   | wallet   | 9002 | `pnpm --filter wallet start`  |
   | auth     | 9003 | `pnpm --filter auth start`    |

Gotchas to know before you present:

- pnpm resolves `file:` dependencies relative to each package directory —
  `file:../../../repack-atlas` from `packages/<app>`, not from the root.
- pnpm **snapshots** `file:` deps. After any `pnpm build` in repack-atlas,
  re-run `pnpm install` in the showcase or the apps keep the old dist.
- Production bundles (`--dev false`) fail without a `code-signing.pem`
  (CodeSigningPlugin). Demo everything in dev mode.
- `repack-atlas init` discovers apps from the workspace globs
  (`pnpm-workspace.yaml` `packages:` or `package.json` `workspaces`), so the
  showcase's `packages/*` apps are found. It still points manifest refs at
  `manifests/<app dir>.json`, which is not how the showcase lays out its
  manifests, so the demo config stays hand-authored (the file is 30 lines —
  show it, don't generate it).

## 1. Beat one: the manifest exists and is reachable

Start one app and show the manifest the plugin emits:

```bash
pnpm --filter auth start
curl -s http://localhost:9003/repack-federation-manifest.json | head -20
```

Expected (verified): HTTP 200 and a manifest with `manifestVersion: 1`,
`id: "auth"`, `metaData.type: "remote"`, the shared array with real resolved
versions (react 19.2.8, react-native 0.86.2, …). The file also exists at
`packages/auth/repack-federation-manifest.json` (`writeToDisk: true`) and
is gitignored. Edit + save a file under `packages/auth/src/` and show the
manifest mtime update on rebuild — the manifest is live, not a build-time
snapshot.

Why `writeToDisk`: in dev, the manifest is emitted as a compilation asset;
Re.Pack's dev server does not serve non-bundle assets and the memory FS
never writes them. The Atlas-owned wrapper writes the asset next to the app
(`VENDORED.md`, bridge addition B1). Without the file on disk, the URL is a
404 — you can demo the cause with `rm packages/auth/repack-federation-manifest.json`
(404) and a rebuild (200 again).

## 2. Beat two: `repack-atlas doctor` on real data

```bash
node ../repack-atlas/dist/cli.js doctor; echo "EXIT=$?"
```

Verified real output on the clean showcase:

```
summary: 0 errors, 62 warnings, 0 info
EXIT=0
```

The 62 warnings are honest findings from the real workspace: 57
`EAGER_ADVISORY` (host is `eager: true`, mini-apps `eager: false` on the
same 19 shared deps — advisory by design) and 5 `HEURISTIC_ADVISORY`
(native modules seen in remotes but missing from the host's heuristic
native list). Present this as "the tool reads your real graph and tells you
what a human would miss", not as "your repo is broken".

The exit-code contract — show all four states, each with its real trigger:

| state | trigger (verified) | result |
|-------|--------------------|--------|
| clean | untouched workspace | 0 errors, 62 warnings, exit 0 |
| drift | edit a gitignored manifest: auth `shared[react].version` 19.2.8 → 19.1.0 | `SHARED_VERSION_DRIFT [static]` error, **exit 1** |
| cycle | synth: auth manifest `remotes`→trading, trading→auth | `REMOTE_CYCLE [static]` warning, **exit 0** (cycles are advisory by design) |
| corrupt | overwrite wallet manifest with garbage | run degrades, `could not answer`, **exit 2** |
| no config | run from a dir with no `repack-federation.json` up the tree | `no repack-federation.json found…`, **exit 2** |

Tamper recipes (all reversible; the manifests are gitignored dev artifacts —
`cp x x.bak` first, restore after; never demo drift by editing source):

```bash
# drift
python3 - <<'EOF'
import json
p='packages/auth/repack-federation-manifest.json'
d=json.load(open(p))
[s for s in d['shared'] if s['name']=='react'][0]['version']='19.1.0'
json.dump(d,open(p,'w'),indent=2)
EOF
node ../repack-atlas/dist/cli.js doctor; echo "EXIT=$?"   # 1
cp packages/auth/repack-federation-manifest.json.bak packages/auth/repack-federation-manifest.json
```

One honesty note to say out loud: exit 2 (could not answer) is deliberately
different from exit 1 (ran and found errors) — CI treats both as failure,
but only 1 means "your federation is wrong".

## 3. Beat three: `repack-atlas dev` + Studio (the GIF)

Kill leftovers, then run the whole workspace through the supervisor:

```bash
for p in 8081 9001 9002 9003 8099; do lsof -ti ":$p" | xargs kill -9 2>/dev/null; done
node ../repack-atlas/dist/cli.js dev
```

Verified event flow: four apps `starting` → `ready` within ~20s
(host 8081, trading 9001, wallet 9002, auth 9003), Studio at
`http://127.0.0.1:8099/`.

For the GIF, record:

1. The runner bringing the four apps up (statuses live).
2. Studio in the browser: 4 ready nodes, **5 real edges** — host→auth,
   host→trading, host→wallet and trading→auth, wallet→auth (the mini-apps
   genuinely consume auth in this showcase), expose list per node, 62
   findings panel, SSE-live (no refresh needed).
3. `curl http://127.0.0.1:8099/api/graph` next to the page — same payload.

Studio is read-only forever (no write endpoints, no config editing, manifest
content rendered as text only, server on 127.0.0.1 only) — worth one line in
the voiceover.

## 4. Wrap-up talking points

- Hexagonal layout in one sentence: `src/core` is bundler-agnostic rules
  (doctor, graph, exit-code asymmetry); `src/adapters` implement ports;
  `src/repack-bridge` is the only Re.Pack-facing surface, with a provenance
  ledger (`VENDORED.md`) and a documented swap condition for when the
  manifest plugin merges upstream.
- The manifest plugin is vendored from `callstack/repack`
  `feat/federation-manifest` @ `c5df67f0` because it is not merged yet;
  when it merges, users switch `manifest: true` to Re.Pack's own option and
  the bridge block is deleted in one commit.
- Honest limits to state rather than dodge: static analysis reports
  `confidence: static | heuristic` and heuristic results downgrade to
  advisories; `SHARED_VERSION_DRIFT` needs manifests that were actually
  built; a corrupt remote currently surfaces as `could not answer` rather
  than a named finding (known UX gap).

## 5. Cleanup

```bash
kill <dev-supervisor-pid>          # tears down all four children
git status --porcelain             # showcase stays clean (demo files are gitignored)
```

The showcase side lives entirely on the `atlas-demo` branch (5 commits:
deps, plugins, writeToDisk, workspace config, lock refresh) and is never pushed or sent
upstream without the owner's call.
