# Studio layout polish

## Objective

The Studio graph and detail panel render the super-app-showcase workspace
without misleading or clipped visuals, so the README GIF shows the real graph.

## Problem

Seen on the live Studio (4 apps, 5 edges) while recording the README GIF:

- The `wallet → auth` edge is drawn as a straight vertical segment that passes
  through the `trading` node, so it reads as `wallet → trading → auth`.
- One `(app-level)` edge label is hidden behind the `trading` node (only `vel)`
  is visible).
- The Native tab's `heuristic` confidence badge wraps inside its pill
  (`heuristi` / `c`).

## Scope

In: T1-T3 in `src/studio/page.ts` plus tests. Out: data or API changes, any
write capability (Studio stays read-only, AGENTS.md rule 5).

## Constraints

AGENTS.md rule 5 (`textContent` / SVG text nodes only, self-contained page,
no CDN). TDD: not configured — ordinary checks plus regression tests where the
layout is testable (`tests/studio/page.test.ts`, `tests/e2e/studio.spec.ts`).

## Tasks

- [x] T1 `fix(studio)`: edges between nodes in the same column route around
  intermediate nodes instead of through them.
- [x] T2 `fix(studio)`: edge labels are never occluded by a node.
- [x] T3 `fix(studio)`: confidence badges never wrap.

Route: delegated writer (layout code needs preparation reading of an 895-line
file plus tests).

## Acceptance criteria

- Screenshot of the live Studio on super-app-showcase: `wallet → auth` visibly
  bypasses `trading`, every `(app-level)` label fully visible, badge on one line.
- `pnpm lint && pnpm typecheck && pnpm build && pnpm test` green;
  `pnpm test:e2e` green.

## Progress

Branch `fix/studio-layout` from `main` (390f00e).

- T1 `2ef747b`: same-column edges bow out to the right of the column, one lane
  per overlapping edge; arrowheads land on the target's right side.
- T2 `56088d3`: labels start at the bowed curve, are nudged off nodes and other
  labels, and the viewBox widens to fit them.
- T3 `9e17c91`: `.pill` and pill cells are `nowrap` with a min-width.
- Tests: `tests/e2e/studio.spec.ts` builds a temporary host + 3 stacked remotes
  workspace (5 edges, heuristic native module) and asserts no crossing, no
  label/node overlap and a one-line badge; `tests/studio/page.test.ts` guards
  the CSS.
- Checks: see the final report of the writer (lint, typecheck, build, test,
  test:e2e, check:commits).
