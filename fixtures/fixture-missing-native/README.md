# fixture-missing-native — provokes `MISSING_NATIVE_MODULE`

Full copy of `../workspace` where `mini_store` uses the native module
`react-native-maps`, which the host does not link. The host's native list is
**trusted** (`dynamicImportDetected: false`, every entry `confidence:
"static"`), so the doctor can state the gap as an error instead of an
advisory.

Delta vs the clean workspace: only `reactNative.nativeModules` in
`manifests/mini-store.json` (adds `react-native-maps`).

| Finding code            | Severity | Confidence |
|---|---|---|
| `MISSING_NATIVE_MODULE` | error | static |

- Expected exit code: **1** (ran and found errors)

Contrast with `fixture-heuristic-downgrade`: the same gap with an untrusted
host list downgrades to `HEURISTIC_ADVISORY` / warning / exit 0.
