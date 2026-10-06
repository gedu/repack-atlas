# Studio: the Inspector must never outgrow the Graph panel

Origin: user report with a screenshot (`~/Desktop/zLongShared.png`). Over a real
workspace the selected app declares ~20 singleton packages, so the `Shared`
inspector tab renders a table far taller than the graph. Because `.main` is a
two-column grid with `align-items: start`, the inspector panel grew freely and
pushed the per-app **Findings** panel (`#app-findings`) far down the page — the
user has to scroll past 20 rows to reach the table below.

Branch `fix/studio-inspector-height` from `main` (`c85d1f1`, after #74).

## Design decision (confirmed with the user)

1. **The Inspector is exactly as tall as the Graph panel**, its body scrolls
   inside the card. Pure CSS, no measuring in JS, no `position: sticky`. The
   two column bottoms stay aligned, so the Findings panel position stops
   depending on how many rows the selected tab happens to have.
2. Mechanism: the row height is driven by the graph panel alone; the inspector
   contributes nothing to it because it becomes a flex column with
   `min-height: 0` + `overflow: hidden` and its `.tab-body` is a scroll
   container with `min-height: 0` + `overflow: auto`. Grid's default
   `align-items: stretch` (the current `align-items: start` is dropped) then
   gives the inspector the row height. Short tabs leave whitespace at the
   bottom of the card — accepted by the user as the trade for a stable layout.
3. Single-column mode (`max-width: 900px`) keeps hugging its content: each
   panel owns a row there, an auto-height scroller never needs to scroll.
4. Non-goals (this change): the **Compare** matrix keeps its current sizing —
   explicitly deferred by the user; no JS height measurement; no sticky
   inspector; no new data, findings, endpoints or dependencies; Studio stays
   read-only and offline (AGENTS.md rule 5).

## Tasks

- [x] T1 Tests first (RED over the current CSS): e2e over a stacked workspace
      whose host declares many shared packages asserts (a) the inspector panel
      height equals the graph panel height, (b) `#tab-body` is actually
      vertically scrollable, (c) `#app-findings` starts right below the graph
      panel; plus a static guard in `tests/studio/page.test.ts` for the CSS
      contract (no `align-items: start` on `.main`, inspector scroller).
- [x] T2 Green: CSS-only change in `src/studio/page.ts` as in the decision
      above; `renderShared` and the data path untouched.
- [x] T3 Docs: one clause in `docs/PRD.md` §7.2 layout description.
- [x] T4 Checks: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
      `pnpm agent:check`, `pnpm exec playwright test tests/e2e/studio.spec.ts`.
- [x] T5 Close: work-unit commit `b8cd023` on `fix/studio-inspector-height`;
      native RDD review over that commit: lineage `review-24657eb2cea255dd`,
      tier medium (lens review-reliability), closure `approved`, acknowledgement
      burned authority `sha256:092a13471e…`, no correction round.

## Evidence log

- **RED observed first** (before any CSS change): the three new browser tests
  failed — inspector vs graph height differed by ~330px on the long tab, and on
  the SHORT tab the inspector was 221px *shorter* than the graph panel (today
  `align-items: start` leaves the two cards unmatched in both directions).
- **GREEN**: `contain: size` on `.panel-inspector` + default `stretch` on
  `.main` + `.tab-body { min-height: 0; overflow: auto }`. Screenshot confirms
  the card ends at the graph's bottom edge, the 24-row table is cut at
  `@acme/shared-07`, and `FINDINGS · HOST (1)` sits directly under the graph.
- **Bug caught by the new stacked test**: the `@media (max-width: 900px) {
  contain: none }` override was originally declared BEFORE the base
  `.panel-inspector` rule, so it lost the cascade and the stacked layout
  collapsed. Fix: declare the override after the base rule; the static guard now
  asserts that order, not just the text.
- **Guard is not decorative**: removing `contain: size` from the CSS makes
  `tests/studio/page.test.ts` fail on `/\.panel-inspector \{[^}]*contain:\s*size/`.
- **Checks (observed output)**: `pnpm build` clean · `pnpm typecheck` clean ·
  `pnpm lint` clean · `pnpm test` 934/934 pass, 0 fail · `pnpm exec playwright
  test tests/e2e/studio.spec.ts` 32 passed (7.1s) · `pnpm agent:check` OK (5
  skills in sync) · `pnpm check:commits` OK.
- Budget: 262 insertions / 6 deletions across 4 files + this doc — inside the
  400-line PR budget.
