# discovery-packages

Discovery-only fixture for `repack-atlas init` (issue #8): a pnpm workspace
whose apps live under `packages/*` next to one non-app package.

- `packages/host`, `packages/feature-auth`: apps (`rspack.config.js` + a
  `start` script).
- `packages/ui-kit`: a plain library package, never reported as an app.

It has no manifests and is not part of the doctor expectation table; only
`tests/cli/init.test.ts` uses it (on a temp copy). Its rspack configs carry no
plugin imports because `init` never evaluates them.
