# fixture-heuristic-downgrade — provokes `HEURISTIC_ADVISORY`

Same native-module gap as `fixture-missing-native` (`mini_store` uses
`react-native-maps`, the host lacks it), but the host's
`reactNative.dynamicImportDetected` is `true`: its native list may be
incomplete, so the doctor is not allowed to claim an error. The finding
downgrades to an honest advisory (AGENTS.md rule 7 — heuristics never error).

Delta vs the clean workspace: `reactNative.nativeModules` of
`manifests/mini-store.json` (adds `react-native-maps`) and
`reactNative.dynamicImportDetected: true` in `manifests/host.json`.

| Finding code         | Severity | Confidence |
|---|---|---|
| `HEURISTIC_ADVISORY` | warning | heuristic |

- Expected exit code: **0** (warnings and advisories allowed)
