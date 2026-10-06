# Reduce doctor signal-to-noise: eager advisory to info, collapse by code

## Objective

The Studio / CLI findings panel on a real workspace (super-app-showcase) shows
`0 errors · 62 warnings · 0 infos`, 57 of them `EAGER_ADVISORY`. Reviewers
either read a wall of text or stop reading the panel at all. Make the default
view show what a human should act on, without weakening the CI gate.

## Problem

- `EAGER_ADVISORY` (`src/core/doctor.ts:127-137`) fires when host `eager: true`
  and remote `eager: false` — that is the Module Federation convention
  (host-eager / remote-lazy), so it is expected, not suspicious.
- The rule is **(dep × remote)**: the showcase has 19 shared deps × 3 mini-apps
  = 57 findings for one fact. 3 more mini-apps → 114. Verified against
  `super-app-showcase/repack-federation.json` (host 19/19 eager, remotes 0/19).
- Human output groups by severity only (`src/cli/format.ts:19-23`), so changing
  severity alone would rename `warnings (57):` to `infos (57):` and change
  nothing about the wall.
- Studio lists every finding flat (`src/studio/page.ts:880-917`), with no way to
  filter by severity or code.

## Decisions

- **Severity**: `EAGER_ADVISORY` (conventional direction) becomes `info`.
  `EAGER_MISMATCH` (reverse direction — a real two-Reacts risk) stays `error`,
  so the gate keeps its teeth. Rejected: demoting both directions.
- **Presentation, both surfaces**: default human view shows `error` + `warning`
  expanded; `info` collapsed to one line per finding code with a count.
  `--show-infos` expands them. `--code <CODE>` (repeatable) filters to named
  codes and shows those expanded.
- **Grouping is presentation, so it lives in `src/cli/format.ts`**, never in
  `src/core/doctor.ts` (`formatDoctorReport` is ported upstream with
  byte-identical messages; the core boundary forbids CLI concerns in core).
- **`--json` never filters, collapses, or reorders.** The machine contract keeps
  every finding at full fidelity. Grouping is a human-output feature only.
- **Studio**: client-side chips per severity (error/warning on, info off by
  default) plus per-code groups with counts, expandable. `textContent` only —
  manifest content stays untrusted; no new endpoints (Studio is read-only
  forever).
- **Documented contract change**: the severity of an existing finding code is
  changing, and `EAGER_ADVISORY` stops escalating under `--fail-on-warnings`
  (which only escalates non-heuristic warnings). Codes themselves are unchanged,
  so `--json` keys stay additive; the semantic change is recorded in PRD, README
  and the `atlas-doctor-finding` skill.
- Out of scope: batching/merging the underlying rule into one finding per dep,
  suppressing advisories in a config file, changing any other code's severity.

## Tasks

- [x] T1 `EAGER_ADVISORY` → `info` in core + ported core tests. Route:
      delegated writer. → commit 8b74dd0
- [x] T2 `fixtures/fixture-eager-advisory` + README + spawned-bin integration
      test (skill checklist: no fixture means an untested claim). Route:
      delegated writer stalled mid-delta; parent finished inline.
      → commit 44e019b
- [x] T3 CLI: collapse by code, info hidden by default, `--show-infos`,
      repeatable `--code`, help + argv spec. Route: delegated writer.
      → commit c1c046f
- [x] T4 Studio: severity chips + per-code groups, info off by default, e2e
      updated. Route: delegated writer (task muvgjjel-4-ogph). → commit
      d43208f (15 e2e pass, 909 unit pass, zero innerHTML verified).
- [x] T5 Docs: PRD, README, `docs/demo-showcase.md`, `atlas-doctor-finding`
      skill + `pnpm agent:check`. Route: delegated writer; parent filled the
      corrupt-state showcase counts with a fresh verified run (1 error, 4
      warnings, 38 info, exit 1; showcase restored clean). → commit cad9ce2
- [x] T6 Full checks + real output captured from fixtures and the showcase.

## Checks

`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e &&
pnpm agent:check && pnpm check:vendored`, plus real runs:
`node dist/cli.js doctor --workspace fixtures/fixture-eager-advisory` (and with
`--show-infos`, `--code`, `--json`, `--fail-on-warnings`), and the same over
`../super-app-showcase`. Paste observed output (AGENTS.md rule 9).

## TDD

Mode: test-first where a meaningful RED exists.

- T1 has a genuine RED: the ported core test asserts
  `severity === 'warning'` (`tests/core/doctor.test.ts:97-101`); invert the
  expectation, observe RED, then change the rule.
- T3/T4 are presentation over pure inputs: write the pure grouping helper's
  test first, then the formatter/UI.
- T5 is passive docs; verified by the real command output it quotes.

Runner: `pnpm test` (node:test + tsx), `pnpm test:e2e` (Playwright chromium —
installed locally, chromium-1243).

## Review posture (RDD on)

Native review candidate per work unit (one commit per task), never the whole
branch. Expected size: T1 ~40 lines, T2 ~120 (fixture), T3 ~180, T4 ~200
(Studio page + spec), T5 ~90 docs. If T4 grows past the 400-line PR budget it
splits from T3 rather than merging.

## Progress

- Baseline captured: `pnpm exec tsx --test tests/core/doctor.test.ts` → 50
  tests, 50 pass, 0 fail (before any edit).
- Environment: node v24.18.0, pnpm 11.23.0, Playwright chromium present.
- Real workspace evidence: `super-app-showcase` host declares 19/19 shared deps
  `eager: true`; trading/wallet/auth declare 0/19 → exactly 57 advisories.
- T3 observed on the real showcase after the change: default output shows
  `warnings (5)` with `+ 4 more`, `infos (57 hidden — --show-infos or --code
  CODE to list)` with `EAGER_ADVISORY [static] × 57`, `summary: 0 errors, 5
  warnings, 57 info`, exit 0.
- T4 launched as background writer (task muvgjjel-4-ogph): Studio severity
  chips + per-code collapse + e2e; surfaces confined to src/studio/page.ts +
  tests/e2e/studio.spec.ts.
- Final battery (parent, observed): lint clean · typecheck clean · build
  clean · test 909/909 · test:e2e 15/15 (4.4s) · agent:check OK 5 skills ·
  check:vendored OK 6 files · check:commits OK 5 items (main..HEAD).
- Showcase corrupt-state re-verified for docs: garbage wallet manifest →
  `MANIFEST_UNREADABLE` naming wallet, `summary: 1 error, 4 warnings, 38
  info`, exit 1; manifest restored (git status clean in the showcase).
- Writer incident (reported honestly): to free port 8099 for Playwright's
  reuseExistingServer, the T4 writer killed a stale `dev` supervisor process
  (PID 71147) that was squatting it. Unrelated to the code change; the user
  was told.
- Native review (RDD): lineage review-d1bae356250f77a8 over the 6-commit
  slice (8b74dd0..cad9ce2 plus this doc, 33 paths, tier high). Closure
  **approved**, acknowledgement burned. Advisory follow-ups (informational,
  non-blocking): docs/demo-showcase.md:198, src/core/doctor.ts:130,
  src/cli/format.ts:37-38, src/cli.ts:126.
