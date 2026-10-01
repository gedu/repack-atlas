# Demo runbook — repack-atlas on super-app-showcase

A step-by-step guide for demoing repack-atlas to another developer using the
super-app-showcase workspace. The doctor, manifest, Studio and `dev` numbers
below were run against the real workspace (`atlas-demo` branch, Re.Pack 5.3.0);
the "verified" figures are the actual numbers from those runs, not
projections. Two items were never run there and stay marked **not yet
re-verified on the showcase**: `dev --launch --platform ios` (needs a
simulator) and `init` output without `command`. The repo's tests cover them on
`fixtures/workspace` (stub bundlers and a stub `react-native` CLI).

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
     and `IntrospectionPlugin` from `repack-atlas/introspection`. Both
     plugins receive the very same `shared` object as
     `ModuleFederationPluginV2` (the Module Federation map), so there is no
     second hand-written copy:

     ```ts
     const shared = {
       react: { singleton: true, eager: false, requiredVersion: '19.2.8' },
       'react-native': { singleton: true, eager: false, requiredVersion: '0.86.2' },
     };
     plugins: [
       new ModuleFederationPluginV2({ name, shared, remotes, exposes }),
       new FederationManifestPlugin({ manifest: true, writeToDisk: true, name, shared, remotes, exposes }),
       new IntrospectionPlugin({ name, role, shared, remotes, exposes, port }),
     ];
     ```

     The snippet is simplified: the real configs pass the object returned by
     `getSharedDependencies({ eager })` (host `eager: true`) to all three
     plugins.

     An entry without `version` is resolved from the installed package and
     marked `versionConfidence: "heuristic"` in
     `.repack-atlas/introspection.json`; a string value is read as the
     `requiredVersion`, and an array of package names works too;
   - `repack-federation.json` at the showcase root with the host + 3 remotes:
     `root`, `port` and the file manifest ref per app, and no `command`.
     Drop the `command` overrides (or keep them; a `command` is run verbatim
     as an override, and earlier runs of this demo used
     `pnpm --filter <name> start`). Without it Atlas builds each app's start
     command itself, which needs `react-native` installed in each app root,
     true for the showcase packages. Verified: with the `command` fields
     removed from host and every remote, `dev` ran all four apps.
3. Install and warm up:

   ```bash
   cd ../super-app-showcase
   pnpm install          # snapshots the file: dep — re-run after tool rebuilds
   ```

4. Port map. The ports come from the workspace config; ask Atlas instead of
   keeping a table by hand:

   ```bash
   node ../repack-atlas/dist/cli.js dev --dry-run --no-interactive
   ```

   Verified output on the showcase (cwd shown relative to the showcase root):

   ```
   app      role    port  command                                                            cwd
   host     host    8081  node_modules/.bin/react-native start --port 8081 --no-interactive  packages/host
   trading  remote  9001  node_modules/.bin/react-native start --port 9001 --no-interactive  packages/trading
   wallet   remote  9002  node_modules/.bin/react-native start --port 9002 --no-interactive  packages/wallet
   auth     remote  9003  node_modules/.bin/react-native start --port 9003 --no-interactive  packages/auth
   ```

   There is no `--bundler` in the command: Re.Pack 5.3.0's `start` does not
   declare it, so Atlas omits it. Each app's `react-native.config.js` picks
   rspack instead.

   `--dry-run` prints each app's port and effective command line and spawns
   nothing. The host defaults to 8081 and a busy port exits 1 (add
   `--auto-ports` to move it).

Gotchas to know before you present:

- pnpm resolves `file:` dependencies relative to each package directory —
  `file:../../../repack-atlas` from `packages/<app>`, not from the root.
- pnpm **snapshots** `file:` deps. After any `pnpm build` in repack-atlas,
  re-run `pnpm install` in the showcase or the apps keep the old dist.
- Atlas spawns each app's `node_modules/.bin/react-native` shim, not
  `node <cli.js>`. Under pnpm the shim sets the `NODE_PATH` that lets the RN
  CLI find its platform plugins; without it `start` fails with
  `Unrecognized platform: ios` or `Cannot find module
  '@react-native/community-cli-plugin'`.
- `start` options are feature-detected per app. Re.Pack 5.x does not declare
  `--bundler` or `--standalone`, so Atlas leaves them out and the app's
  `react-native.config.js` decides. Asking for `--standalone` on 5.x exits 2
  with the reason.
- Production bundles (`--dev false`) fail without a `code-signing.pem`
  (CodeSigningPlugin). Demo everything in dev mode.
- `repack-atlas init` discovers apps from the workspace globs
  (`pnpm-workspace.yaml` `packages:` or `package.json` `workspaces`), so the
  showcase's `packages/*` apps are found. It no longer writes a `command`: it
  emits `root` and `port`, and `dev` builds each app's start argv from them.
  (The discovery of the four apps with the same root and port as the
  hand-written config was verified when `init` still wrote
  `pnpm --filter <name> start`; the run without `command` is **not yet
  re-verified on the showcase**.) The manifest refs still differ: init emits
  `manifests/<name>.json`, the showcase keeps
  `packages/<name>/repack-federation-manifest.json`. That is why the demo
  config stays hand-authored (the file is 30 lines — show it, don't generate
  it).

## 1. Beat one: the manifest exists and is reachable

Start one app through Atlas and show the manifest the plugin emits (run the
`curl` from a second terminal while the first keeps the app up):

```bash
node ../repack-atlas/dist/cli.js dev --apps auth --no-studio --no-interactive
curl -s http://localhost:9003/repack-federation-manifest.json | head -20
```

Verified output of the supervisor (the manifest answered within about a
second of `ready`):

```
dev: supervising 1 app(s) (auth:9003)
dev: auth → starting (port 9003)
dev: auth → ready (port 9003)
dev: auth → stopped (port 9003)
```

Expected from the `curl`: HTTP 200 and a manifest with `manifestVersion: 1`,
`id: "auth"`, `metaData.type: "remote"`, the shared array with real resolved
versions (react 19.2.8, react-native 0.86.2, @bottom-tabs/react-navigation
1.4.0, …). The file also exists at
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
| corrupt | overwrite wallet manifest with garbage | `MANIFEST_UNREADABLE [static]` error naming `wallet`, other apps still checked, **exit 1** |
| no config | run from a dir with no `repack-federation.json` up the tree | `no repack-federation.json found…`, **exit 2** |

Real output of the corrupt state (run on `fixtures/fixture-corrupt-manifest`,
where the `mini_store` manifest is truncated JSON; absolute paths shortened).
With the showcase, the finding names `wallet` the same way and the summary
is `1 error, 42 warnings, 0 info` (wallet is not compared, so warnings drop
from 62 to 42), exit 1:

```
$ node dist/cli.js doctor --workspace fixtures/fixture-corrupt-manifest; echo "EXIT=$?"
host:   host  fixtures/fixture-corrupt-manifest/manifests/host.json
remote: mini_auth  fixtures/fixture-corrupt-manifest/manifests/mini-auth.json
remote: mini_store  ./manifests/mini-store.json

errors (1):
  MANIFEST_UNREADABLE [static] Remote "mini_store" has a manifest that exists but could not be read: Manifest at fixtures/fixture-corrupt-manifest/manifests/mini-store.json is not valid JSON. It was not checked; fix or regenerate that manifest.

summary: 1 error, 0 warnings, 0 info
EXIT=1
```

Exit 2 is kept for runs that cannot compare anything: no config, an unreadable
host manifest, or every remote manifest exists but is unreadable. Missing manifests keep
exit 1 (0 with `--allow-missing-manifests`).

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

Kill leftovers, then run the whole workspace through the supervisor. On a
terminal the wizard asks what to run:

```bash
for p in 8081 9001 9002 9003 8099; do lsof -ti ":$p" | xargs kill -9 2>/dev/null; done
node ../repack-atlas/dist/cli.js dev
```

Walk the audience through it: remotes (all preselected; the readline
fallback reads `none` as host only), platform, launch (only
once a single platform is picked), a port per app, standalone. Ctrl-C at any
question exits 0 with nothing started. Then the other two entry points:

```bash
# the plan, without spawning anything or binding the Studio
node ../repack-atlas/dist/cli.js dev --dry-run --platform ios --no-interactive
# put the app on the iOS simulator once the host is ready
node ../repack-atlas/dist/cli.js dev --launch --platform ios
```

Verified on the showcase: the wizard (`dev --dry-run` under a pseudo-terminal,
pressing Enter at every prompt) and the full `dev --json --no-interactive`
session below. The prompts came in this order:

1. "Which remotes to run?" (trading, wallet, auth preselected)
2. "Which app platform are you running?" (All / decide later)
3. The note "Launch skipped: launching the app needs a single platform (ios
   or android)."
4. "Use port 8081 for host?" (Yes), then one per app

The run ended with the same plan table as above and exit 0. A narrow
pseudo-terminal wraps the clack output, so record the GIF in a real terminal
window.

**Not yet re-verified on the showcase**: `--launch --platform ios`. It needs a
simulator, and is covered only by tests on `fixtures/workspace` with a stub
`react-native` CLI.

Verified event flow (`repack-atlas dev --json --no-interactive`): a `studio`
event with `http://127.0.0.1:8099/`, then `starting` for host, trading,
wallet and auth, then all four `ready` about 3s after start on a warm cache
(host 8081, trading 9001, wallet 9002, auth 9003). The auth manifest answered
200. `GET http://127.0.0.1:8099/api/graph` returned the 5 edges. SIGINT
produced `{event:'exit',code:0}` and freed every port. (The earlier ~20s
figure came from starting each app with `pnpm --filter <name> start`.)

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
  ledger (`VENDORED.md`) for the Atlas-owned fork of the manifest plugin.
- The manifest plugin was copied from `callstack/repack`
  `feat/federation-manifest` @ `c5df67f0`. Re.Pack will not merge it, so it
  stays as an Atlas-owned fork and supported Atlas package.
- Honest limits to state rather than dodge: static analysis reports
  `confidence: static | heuristic` and heuristic results downgrade to
  advisories; `SHARED_VERSION_DRIFT` needs manifests that were actually
  built; an unreadable remote manifest is reported by name
  (`MANIFEST_UNREADABLE`) but that remote is not compared; if no remote is
  compared at all, `NOTHING_COMPARED` warns that a clean exit proves nothing.

## 5. Cleanup

```bash
kill <dev-supervisor-pid>          # tears down all four children
git status --porcelain             # showcase stays clean (demo files are gitignored)
```

The showcase side lives entirely on the `atlas-demo` branch. It has 8 commits:
deps, plugins, writeToDisk, workspace config, lock refresh, the shared-map
refactor (`d80e172 refactor(atlas): pass the federation shared map to
introspection`), `28d43bf chore(atlas): let Atlas build each app's start
argv` (which drops the `command` overrides) and a lockfile refresh,
`caf33f4`. The branch is never pushed or sent upstream without the owner's
call.
