# fixtures/fixture-xss — the Studio rendering probe

Copy of [`../workspace`](../workspace) where every user-controlled string in the
manifests is an injection probe: `<script>alert(1)</script>`,
`<img src=x onerror=…>`, `"><svg onload=…>` and friends, placed in app names,
expose names/paths, shared package names and native module packages.

- Purpose: **Studio rendering probe** (docs/PRD.md §7.3 — manifest content is
  untrusted input). `tests/e2e/studio.spec.ts` serves this workspace and asserts
  the page renders the probes as literal text, opens no dialog and injects no
  element.
- Expected doctor findings: **none** — the probes sit in names and paths only,
  never in versions or native-module membership.
- Expected exit code: **0** (clean)

The `apps/*/rspack.config.js` files were regenerated from the manifests, so the
fixture-consistency test keeps comparing config facts against manifest facts
with the same hostile strings on both sides.

See [`../README.md`](../README.md) for the layout rules shared by all fixture
workspaces and the full expectation table.
