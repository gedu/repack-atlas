# Fixture workspaces

Throwaway Re.Pack-style Module Federation workspaces used by the doctor/CLI
tests. `tests/fixtures/consistency.test.ts` runs the core doctor against every
workspace below on each `pnpm test`; the expectation table lives in that test
(single source of truth) and this README mirrors it.

**Budget rule (PRD §9):** everything under `fixtures/` must be consumable in
seconds — no simulator, no network, no `pnpm install` inside a fixture, and no
rspack/Re.Pack build. The suite fakes at the boundary: the doctor consumes
manifest JSON, not compiler output.

## Layout

Every workspace is a full sibling copy (variants differ from `workspace/`
**only** in the delta stated in their README):

```
fixtures/<name>/
├── repack-federation.json     # workspace config (src/core/federation-config schema)
├── manifests/                 # host + one JSON per remote, wired via the config
│   ├── host.json
│   ├── mini-auth.json
│   └── mini-store.json
├── apps/
│   ├── host/                  # federation name: host
│   ├── mini-auth/             # federation name: mini_auth (port 8082)
│   └── mini-store/            # federation name: mini_store (port 8083)
└── README.md                  # what the variant provokes + expected exit code
```

Each app carries a minimal `package.json`, one or two trivial `src/` modules,
and an `rspack.config.js` (see the convention below).

## Dev-runner commands (`repack-atlas dev`)

`workspace/` is the only fixture whose config entries declare a `command`
(`node tools/stub-bundler.mjs` for every app): the runner resolves commands
through a shell with the **config directory as cwd** and injects
`ATLAS_APP_PORT` (the runner-assigned port), `ATLAS_APP_NAME`,
`ATLAS_APP_ROOT` and `ATLAS_APP_MANIFEST`. The stub bundler
(`workspace/tools/stub-bundler.mjs`) serves that app's checked-in
`manifests/*.json` at `/repack-federation-manifest.json` on that port — a
fake dev-server in seconds, honoring the budget rule. Each app's
`package.json` also carries a `dev` script pointing at the same stub for
manual runs from the app directory.

The broken variants intentionally declare **no** commands: `repack-atlas dev`
skips commandless apps with a warning, which is exactly what their runner
tests (e.g. the remote-cycle graph test) rely on.

## Expectation table

| Workspace | Provokes | Severity | Exit |
|---|---|---|---|
| `workspace/` | nothing — clean workspace | — | `0` |
| `fixture-remote-cycle/` | `REMOTE_CYCLE` | warning | `0` |
| `fixture-version-drift/` | `SHARED_VERSION_DRIFT` | error | `1` |
| `fixture-missing-native/` | `MISSING_NATIVE_MODULE` | error | `1` |
| `fixture-corrupt-manifest/` | unparseable manifest → unable to answer | — | `2` |
| `fixture-heuristic-downgrade/` | `HEURISTIC_ADVISORY` | warning (heuristic) | `0` |
| `fixture-missing-remote-manifest/` | `MISSING_REMOTE_MANIFEST` | error (warning with `--allow-missing-manifests`) | `1` (`0` with the flag) |
| `fixture-xss/` | nothing — Studio rendering probe (hostile strings in names/paths) | — | `0` |

## Manifest provenance (why there is no build step)

`manifests/*.json` are **hand-authored**, schema-faithful to
`src/core/manifest-types.ts` (`FederationManifestSchema` v1, the fields the
doctor actually reads). JSON has no comments, so each document carries a
top-level `_provenance` string stating this; core treats manifests as
untrusted, minimal-shape-checked documents, and the extra key is ignored by
every consumer.

Escape hatch, if these ever need to be real compiler output: add each app to a
real rspack workspace (the showcase fork, T-integration) with the
`FederationManifestPlugin` already wired in its `rspack.config.js`, build, and
copy the emitted `repack-federation-manifest.json` over the checked-in file —
nothing downstream changes. Do **not** add a build step to `pnpm test`; the
seconds budget is the point.

## rspack config convention

Atlas is not published under a name these apps can resolve, and workspaces are
consumed from spawned processes, so each `apps/<app>/rspack.config.js` imports
the two plugins through a relative path into the repo build output:

```js
import { FederationManifestPlugin } from '../../../../dist/repack-bridge/plugin.js';
import { IntrospectionPlugin } from '../../../../dist/repack-bridge/introspection-plugin.js';
```

This fixes every workspace at exactly `fixtures/<name>/apps/<app>` — moving an
app deeper or shallower breaks the paths. The configs are never executed by
`pnpm test`; `tests/fixtures/consistency.test.ts` stubs the two plugin
imports, loads each config as ESM, and asserts it registers both plugins with
the federation facts matching the manifests (so T7/T9 spawns don't drown in
avoidable config errors).
