# fixture-version-drift — provokes `SHARED_VERSION_DRIFT`

Full copy of `../workspace` where `mini_store` resolves the singleton
shared dependency `react` to `19.1.0` while the host resolves `19.0.0`.
Both sides keep `singleton: true`, so the versions must agree — they do not.

Delta vs the clean workspace: only `shared[react].version` in
`manifests/mini-store.json` (`19.0.0` -> `19.1.0`).

| Finding code           | Severity | Confidence |
|---|---|---|
| `SHARED_VERSION_DRIFT` | error | static |

- Expected exit code: **1** (ran and found errors)
