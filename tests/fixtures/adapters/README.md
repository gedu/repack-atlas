# Adapter test fixtures — provenance

`config-valid/`, `config-invalid/`, `config-url/` and `config-walkup/` are
verbatim copies of the upstream workspace-config fixtures in
`packages/repack/src/commands/federation/__tests__/__fixtures__/` of
`callstack/repack` branch `feat/federation-shared-config` @ `c5df67f0`.

They are kept byte-identical so the ported reader tests assert exactly the
upstream behaviour (field schema, walk-up precedence, URL sources). Add
Atlas-only fixtures as new directories here rather than editing these.

Upstream directories whose semantics are deferred with the `init` CLI
(`config-standalone*`, `config-noport`, `config-drift` — consumed by
`assertStandaloneSupported`/`resolveFederationWorkspace`, T7) are not copied
until that task needs them.
