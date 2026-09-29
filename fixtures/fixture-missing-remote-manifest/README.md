# fixture-missing-remote-manifest — provokes `MISSING_REMOTE_MANIFEST`

Full copy of `../workspace` with `manifests/mini-store.json` deleted while
`repack-federation.json` still declares the `mini_store` remote: the remote
was never checked because nothing is served for it. That is an answer
(`MISSING_REMOTE_MANIFEST`, error → exit 1), deliberately **not** the "could
not answer" class of `fixture-corrupt-manifest` (exit 2).

Delta vs the clean workspace: `manifests/mini-store.json` does not exist.

| Finding code             | Severity | Confidence |
|---|---|---|
| `MISSING_REMOTE_MANIFEST` | error | static |

- Expected exit code: **1** (ran and found errors)
- With `--allow-missing-manifests`: the same finding is reported as a
  warning and the exit code is **0** (warnings allowed).

Contrast with `fixture-corrupt-manifest`: a manifest that exists but cannot
be parsed is exit 2, because the run cannot answer at all.
