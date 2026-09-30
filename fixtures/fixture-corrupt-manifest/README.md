# fixture-corrupt-manifest — provokes `MANIFEST_UNREADABLE`

Full copy of `../workspace` where `manifests/mini-store.json` is not valid
JSON (truncated mid-entry). The manifest exists but cannot be parsed, which
is deliberately **not** the same thing as "missing": the doctor names the app
behind it with a `MANIFEST_UNREADABLE` error (app name, manifest reference and
parse reason), keeps checking the other remotes, and exits 1.

Exit 2 ("could not answer") stays for runs with nothing to compare against: a
missing or invalid config, an unreadable host manifest, or every remote
manifest unreadable (AGENTS.md rule 6 keeps 1 and 2 distinguishable because
they imply different fixes).

Delta vs the clean workspace: only `manifests/mini-store.json` is replaced
with unparseable content.

| Condition        | Severity | Confidence |
|---|---|---|
| unparseable remote manifest → `MANIFEST_UNREADABLE` (names `mini_store`) | error | static |

- Expected exit code: **1** (ran and found an error)
