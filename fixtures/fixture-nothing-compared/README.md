# fixture-nothing-compared — provokes `NOTHING_COMPARED`

Full copy of `../workspace` with **both** remote manifests
(`manifests/mini-auth.json`, `manifests/mini-store.json`) deleted while
`repack-federation.json` still declares the `mini_auth` and `mini_store`
remotes: only the host manifest exists, so no remote was compared.

Delta vs the clean workspace: `manifests/mini-auth.json` and
`manifests/mini-store.json` do not exist.

| Finding code | Severity | Confidence |
|---|---|---|
| `MISSING_REMOTE_MANIFEST` (one per remote) | error | static |
| `NOTHING_COMPARED` | warning | static |

- Expected exit code: **1** (the missing manifests are errors).
- With `--allow-missing-manifests`: `MISSING_REMOTE_MANIFEST` becomes a
  warning and the exit code is **0**, but `NOTHING_COMPARED` is still
  reported, so a clean exit is not read as "the federation was checked".

The exit-code contract is the same as `fixture-missing-remote-manifest`; the
warning never moves it. It is not emitted when every remote manifest exists
but is unreadable (exit 2): `MANIFEST_UNREADABLE` already names each app.
