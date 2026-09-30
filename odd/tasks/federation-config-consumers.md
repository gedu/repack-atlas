# Federation config consumers — host port and validation fixes

## Objective

Every field of `repack-federation.json` reaches its consumers the same way for
the host and the remotes, and invalid ports are rejected at validation time.

## Problem

Surfaced while recording the README GIF on super-app-showcase: the Studio shows
the host as `no port` although the config declares `"port": 8081`.

- `src/core/graph.ts` builds the roster with `{ role: 'host' }` and drops
  `config.host.port` (remotes keep theirs).
- `src/cli/init.ts` writes the host entry as `{ manifest, root }` and drops the
  port introspection found (remotes keep theirs).
- `optionalNumber` in `src/core/federation-config.ts` accepts NaN, floats, 0 and
  negatives; only the runner range-checks, and only for apps with a `command`.
- The validator JSDoc omits `host.port`, `command` on both entries.

## Scope

In: T1-T3 below. Out (follow-ups): `init` never writes `command`; `standalone`
is validated but unused; Studio layout nits (wallet→auth edge drawn through the
trading node, clipped `(app-level)` label, wrapped `heuristic` badge).

## Constraints

AGENTS.md hard rules (core boundary, exit codes, conventional commits without AI
attribution, real output for every check). TDD: not configured (source: no
project/session setting) — ordinary functional checks with regression tests.

## Tasks

- [x] T1 `fix(graph)`: host roster entry carries `config.host.port`; regression
  tests in `tests/core/graph.test.ts` (host port shown; survives missing host
  manifest and manifest `name` != `host`). Route: delegated writer (T1-T3, 2+
  non-trivial files).
- [x] T2 `fix(init)`: generated host entry keeps the introspected port;
  regression test in `tests/cli/init.test.ts`.
- [x] T3 `fix(config)`: `port` must be an integer in 1..65535 for host and
  remotes; JSDoc lists every accepted field; tests in
  `tests/core/federation-config.test.ts`.

## Acceptance criteria

- Studio `/api/graph` on super-app-showcase reports `host.port = 8081`.
- `pnpm lint && pnpm typecheck && pnpm build && pnpm test` green.

## Checks

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, live `/api/graph`.

## Progress

Branch `fix/federation-config-consumers` from `main` (390f00e).

Commits: `4326d0d` T1 (also stops a manifest-named host input from adding a
second, portless node), `8962b6e` T2, `4a649bd` T3.

Verification (2026-09-30):

- `pnpm lint`: `eslint .` clean. `pnpm typecheck`: clean. `pnpm build`: clean.
- `pnpm test`: `tests 299`, `pass 299`, `fail 0`.
- `pnpm check:commits`: `commit-check: OK - 3 item(s) checked`.
- super-app-showcase `doctor`: `0 errors, 62 warnings, 0 info`, exit 0.
- live `/api/graph`: `host:8081 auth:9003 trading:9001 wallet:9002`, all
  `ready`, 5 edges, 62 findings.

Next: re-record the README GIF on `docs/readme-gif`; file the out-of-scope
follow-ups as issues.
