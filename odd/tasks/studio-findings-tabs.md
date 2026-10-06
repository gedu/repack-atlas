# Studio: split Apps and Doctor into top-level tabs

Origin: user report after the signal-to-noise slice. Selecting `wallet`
(badge 1) still showed the workspace-wide 5-warning list; host badge 5 and
remote badges 4+1 sum past 5 because one HEURISTIC_ADVISORY mentions both the
remote and the host (`findingsFor` links by name occurrence). The flat page
mixes two different scopes and reads like a stale counter.

## User decisions (confirmed)

1. Top-level tab navigation between the header and the content, two tabs:
   - **Apps** (host + mini-apps): graph + inspector, and below them a simple
     findings panel for the selected app only — no severity chips, no
     per-code collapse (subsets are small).
   - **Doctor**: the whole current findings table (chips, collapse, hints,
     global counts) exactly as it works today.
2. Node badge: just label it "N findings" — tooltip/aria wording, do not
   over-complicate. Keep the current mention-based counts (cosmetic link).
3. Tidy the HTML while in there where cheap (no framework, std-lib DOM only).

## Constraints

- Studio stays read-only; `textContent` / SVG text nodes only, no
  `innerHTML` (AGENTS.md rule 5). Server untouched — this is `page.ts`.
- Existing e2e specs in `tests/e2e/studio.spec.ts` address `#issues`,
  `#issue-chips`, `#issue-count`; they must click the Doctor tab first, and
  new specs cover the Apps-tab panel filtering by selection.
- Keep element ids where tests/behavior depend on them unless the spec moves
  with them deliberately.
- Clicking a finding row in the Doctor tab should switch to the Apps tab and
  select that app (same selection jump as today, now across tabs).

## Tasks

- [x] S1 Top-level tab nav (Apps | Doctor) in `src/studio/page.ts`; panels
      show/hide by tab; default Apps. Badge tooltip/aria says
      "N findings mention <app>". Panel under the graph lists
      `findingsFor(selected)` with the existing row rendering, plus a hint
      when the app has none.
- [x] S2 E2E: adapt existing Doctor specs (open Doctor tab), add Apps-tab
      specs: selecting wallet shows only its finding; host shows the 5;
      Doctor tab still shows global chips/collapse; finding click lands on
      Apps tab with the app selected.
- [x] S3 Checks: pnpm typecheck, lint, build, pnpm test:e2e (all specs), and
      agent:check if docs touched. Update docs/demo-showcase.md + PRD studio
      section with real observed output if the copy describes the old layout.
- [x] S4 Close: work-unit commit(s), native review per RDD over the resulting
      candidate. Approved over the whole branch (lineage
      review-0853533d4aade7c8, tier high), acknowledgement burned; advisory
      follow-ups only.

## Evidence log

(append commits, outputs, review lineage ids here)

- S3 verified by the parent on `../super-app-showcase` via
  `tools/studio-preview.mjs --port 8098` + a headless chromium probe against
  the built page: default tab Apps with `#view-doctor` hidden;
  `Findings · host (5)` + 5 rows + hint `57 info findings hidden — the Doctor
  tab lists them.`; `wallet (1)` + 1 row; `auth (0)` + hidden-infos hint;
  Doctor tab shows `0 errors · 5 warnings · 57 infos` and the three chips.
  Battery: playwright studio.spec 21 passed; typecheck/lint/build clean;
  pnpm test 909/909; agent:check OK.
- S3 commit: e9d272e feat(studio): split Apps and Doctor views and scope
  findings panel to selection (includes the badge-scope follow-up fix).

S1/S2 implemented (not yet committed). Shape as built:

- `#view-tabs` (`role="tablist"`, `Apps` / `Doctor`), two `.view` sections
  (`#view-apps`, `#view-doctor` hidden via the `hidden` attribute); module
  var `view`, set only by `setView`, never reset by `applyGraph`/`render`.
- Apps view adds `#app-findings` (`#app-findings-title` =
  `Findings · <app> (N)`, rows in `#app-issues`) rendered from
  `findingsFor(selected)` inside `render()`; hint `No findings mention <app>.`
  when empty. No chips, no collapse.
- Badge group: SVG `<title>` + node `aria-label` now end with
  `N findings mention <app>`; counts unchanged (error+warning mentions).
- Doctor row click now `setView('apps')` before `select(...)`.
- Tidy: `moreButton()` helper replaces the duplicated issue-more markup.

Verification observed:

- `pnpm exec playwright test tests/e2e/studio.spec.ts` → `20 passed (4.2s)`.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` clean; `pnpm test` →
  `909 pass / 0 fail`; `pnpm agent:check` OK.
- Fixture reality note: `fixture-eager-advisory` has host/mini_auth/mini_store
  (no `wallet`), and every app there is mentioned by infos only, so the
  `No findings mention <app>.` hint is asserted on `fixtures/workspace` (zero
  findings) and on the cycle fixture's host. See the follow-up note below for
  the counts each spec now asserts.

Follow-up fix: panel scope aligned with the badge (not yet committed):

- Problem: `drawGraph` badges count error+warning mentions only, while
  `renderAppFindings` listed every severity, so a showcase host would read a
  badge of 5 against `Findings · host (62)`.
- Now `renderAppFindings` splits `findingsFor(app)` into the error+warning set
  (listed, and the header count: the same set the badge counts) and an infos
  count. Zero listed and zero infos prints `No findings mention <app>.`; zero
  listed with infos prints `<N> info finding(s) hidden: the Doctor tab lists
  them.` (singular/plural honest); otherwise the rows, then that hint when
  infos also mention the app.
- Specs adjusted to what the code now produces per fixture: eager-advisory
  host prints `Findings · host (0)`, 0 rows and the 4-info hint; mini_auth the
  same shape with 2; mini_store's hint count is recomputed from `api/graph`.
  `fixtures/workspace` keeps the zero-mention hint spec (no findings there).
  A new cycle-fixture spec covers the listed path: mini_auth prints
  `Findings · mini_auth (1)` with one `REMOTE_CYCLE` row and no hint, and host
  prints `Findings · host (0)` with `No findings mention host.` because the
  cycle message never names the host.
- Re-run observed: `pnpm exec playwright test tests/e2e/studio.spec.ts` ->
  `21 passed (5.3s)`; `pnpm typecheck`, `pnpm lint` and `pnpm build` clean.
