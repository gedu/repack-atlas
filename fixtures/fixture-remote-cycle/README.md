# fixture-remote-cycle — provokes `REMOTE_CYCLE`

Full copy of `../workspace` where the two mini-apps consume **each other**:
`mini_auth` lists `mini_store` as a remote and `mini_store` lists
`mini_auth`. The doctor's cycle rule (Atlas addition over upstream) reports
one strongly-connected component.

Delta vs the clean workspace: only the `remotes[]` arrays of
`manifests/mini-auth.json` and `manifests/mini-store.json`.

| Finding code  | Severity | Confidence |
|---|---|---|
| `REMOTE_CYCLE` | warning | static |

- A cycle is a structural smell, not a version lie, so it never moves the
  exit code off 0 (AGENTS.md rule 6).
- Expected exit code: **0**
