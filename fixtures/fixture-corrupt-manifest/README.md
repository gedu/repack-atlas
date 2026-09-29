# fixture-corrupt-manifest — provokes exit code `2`

Full copy of `../workspace` where `manifests/mini-store.json` is not valid
JSON (truncated mid-entry). The manifest exists but cannot be parsed, which
is deliberately **not** the same thing as "missing": the run cannot answer,
so the doctor reports `unableToAnswer` and the process exits 2 instead of
1 ("bad answer") — AGENTS.md rule 6 keeps the two distinguishable because
they imply different fixes.

Delta vs the clean workspace: only `manifests/mini-store.json` is replaced
with unparseable content.

| Condition        | Severity | Confidence |
|---|---|---|
| unparseable remote manifest → `unableToAnswer` | — (no finding) | — |

- Expected exit code: **2** (could not answer)
