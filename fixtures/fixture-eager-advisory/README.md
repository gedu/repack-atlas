# fixture-eager-advisory — provokes `EAGER_ADVISORY`

Full copy of `../workspace` where both mini-apps declare their shared deps
`eager: false` while the host keeps them `eager: true` — the expected
host-eager/remote-lazy Module Federation convention. The doctor reports the
mismatch honestly but as information, not a warning: nothing here is wrong.

Delta vs the clean workspace: only the `eager` flag of the `react` and
`react-native` shared entries in `manifests/mini-auth.json`,
`manifests/mini-store.json` and the matching `apps/*/rspack.config.js`
(`singleton` and versions stay identical, so no other finding fires).

| Finding code    | Severity | Confidence |
|-----------------|----------|------------|
| `EAGER_ADVISORY` | info    | static     |

- The convention is expected, not suspicious, so it is `info` — and `info`
  never moves the exit code, not even under `--fail-on-warnings` (which only
  escalates static warnings). The reverse direction (host lazy, remote eager)
  stays the `EAGER_MISMATCH` error.
- Expected exit code: **0**
