---
name: atlas-doctor-finding
description: >-
  Add or change a doctor finding end to end: pure rule code in src/core, one
  fixture workspace variant per finding, the --json report shape, exit-code
  semantics 0/1/2, docs and tests. Trigger: adding or changing a doctor check or
  finding, a finding code such as REMOTE_CYCLE or SHARED_VERSION_DRIFT, the
  doctor --json output shape, or a finding that has no fixture yet.
metadata:
  auto_invoke:
    - "adding a new doctor finding code"
    - "changing an existing doctor rule or its severity"
    - "changing the doctor --json report shape"
---

# Adding a doctor finding

`repack-atlas doctor` is a CI gate. Its value is that a finding code means the
same thing everywhere, so the rule, the fixture, the JSON and the exit code must
land together — a finding without a fixture is an untested claim.

## Layering (non-negotiable)

- Rule logic lives in `src/core/**`: pure functions over plain JSON manifests.
  No `@callstack/repack`, no `@rspack/*`, no `webpack`, no bridge or adapter
  imports — the `atlas/core-boundary` lint rule fails the build.
- Reading manifests, configs and the filesystem happens in adapters behind ports
  owned by core. The finding itself never knows where JSON came from.

## Checklist

Work through it in order; every box is a file in the same PR.

1. **Finding code and severity.** Add the code to the findings model in
   `src/core` (e.g. `MISSING_NATIVE_MODULE`) with severity and a message that
   names the package and the conflicting versions. Codes are `SCREAMING_SNAKE`
   and are part of the public `--json` contract: adding is fine, renaming needs
   a deprecation note.
2. **Rule in core.** Pure function: inputs are manifests/config, output is a
   list of findings. No I/O, no `Date.now()`, no environment reads.
3. **Honest confidence.** Static analysis must declare `static` or `heuristic`.
   A `heuristic` finding (or `dynamicImportDetected`) downgrades to an advisory
   rather than an error — Atlas reports what it cannot check instead of
   guessing. Never promote a heuristic to an error to make a test pass.
4. **Fixture variant.** One variant per finding under `fixtures/fixture-<kebab-name>/`
   (a short descriptive name such as `fixture-remote-cycle` for `REMOTE_CYCLE`;
   the clean baseline is `fixtures/workspace`)
   with a `README.md` stating the provoked finding and the expected exit code.
   Keep it Rspack + MF2, no real UI, no simulator, no network, and keep the
   whole suite inside the seconds budget (PRD §9).
5. **Test.** Unit test for the pure rule plus an integration test that spawns
   `dist/cli.js` against the fixture, parses `--json` and asserts the exit code.
6. **Docs.** Update the findings table (command docs / README section listing
   codes) with meaning and exit code.

## Exit-code semantics (locked)

| Exit | Meaning | CI treats as |
|---|---|---|
| `0` | Clean. Warnings allowed. | pass |
| `1` | Ran and found a problem: any error-severity finding (incl. `MISSING_REMOTE_MANIFEST` unless `--allow-missing-manifests`). | fail (bad answer) |
| `2` | Could not answer: missing required option, host manifest missing or corrupt. | fail (no answer) |

`1` and `2` must stay distinguishable — "bad answer" and "no answer" imply
different fixes. Warnings and advisories never move the exit code off `0`.

## `--json` shape

Stable, machine-readable, one report per run:

```json
{
  "tool": "repack-atlas",
  "doctorVersion": "1",
  "exitCode": 1,
  "summary": { "errors": 1, "warnings": 0, "advisories": 0, "infos": 0 },
  "findings": [
    {
      "severity": "error",
      "code": "SHARED_VERSION_DRIFT",
      "confidence": "static",
      "message": "Singleton shared dependency \"react\" resolves to different versions: host \"host\" has 19.0.0, remote \"mini_store\" has 19.1.0. Align the versions (or remove singleton)."
    }
  ]
}
```

Excerpt from `node dist/cli.js doctor --workspace fixtures/fixture-version-drift --json`.

Contract rules: human-readable output is the default and `--json` is the
machine interface; `exitCode` in the payload mirrors the process exit code;
every finding carries `severity`, `code`, `confidence` and a message naming the
package and versions. Additive fields are allowed, removals or renames are
breaking.

## Verify

```bash
pnpm lint && pnpm typecheck && pnpm test
node dist/cli.js doctor --workspace fixtures/fixture-<kebab-name> --json; echo "exit=$?"
```

Report the real exit code and output in the PR — never a claimed pass.
