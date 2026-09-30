# Core test fixtures — provenance

`host.json`, `remote-clean.json` and `remote-conflicting.json` are verbatim
copies of the upstream doctor fixtures in
`packages/repack/src/commands/federation/__tests__/__fixtures__/` of
`callstack/repack` @ `c5df67f0` (branch `feat/federation-manifest`).

They are kept byte-identical so the ported doctor tests in
`tests/core/doctor.test.ts` assert exactly the upstream behaviour. Add
Atlas-only fixtures (e.g. cycle graphs) as new files here rather than editing
these three.
