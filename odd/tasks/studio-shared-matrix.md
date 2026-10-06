# Studio: shared-dependency matrix across apps

Origin: issue gedu/repack-atlas#73. The `Shared` inspector tab shows one app in
isolation (`renderShared` says so in its own hint), so the #1 Module Federation
failure in React Native — two copies of React — is readable only as one
sentence per remote in the Doctor tab. `FederationGraph.apps[].shared[]`
already carries `name`, `version`, `requiredVersion`, `singleton`, `eager`;
nothing projects it across apps.

Branch `feat/studio-shared-matrix` from `d147683` (main, after #68).

## Design decisions (confirmed with the user)

1. The projection is **pure core code** (`buildSharedMatrix` in
   `src/core/graph.ts`), not page logic: the Studio draws, it does not judge.
   Attached to `FederationGraph` as `sharedMatrix` so the page keeps its single
   `fetch('api/graph')`.
2. Reference column is **the host** (first app when no host exists). Every cell
   compares against the host's declaration of that package — this mirrors what
   `runDoctor` actually proves (`checkSharedDeps(host, remote)`) and is what
   keeps AGENTS.md rule 7 honest. Remote↔remote is #55 and stays out.
3. Cell statuses derive from the doctor's own branches: `absent`, `unknown`
   (a version is `unknown` — never a pass), `drift` (both singleton, versions
   differ = `SHARED_VERSION_DRIFT`), `singleton-mismatch`
   (`SINGLETON_MISMATCH`), `match`.
4. Third top-level tab **Compare** between Apps and Doctor; rows = packages,
   columns = apps (host first, remotes alphabetical — the `renderSessions`
   order). Verdict rides the existing `.pill` language (`ok`/`warn`/`bad`);
   `absent` is a plain `—`. Non-singleton rows render but stay neutral.
5. Non-goals: no remote↔remote, no new finding codes, no severity changes, no
   native-module matrix (follow-up), no filters, no write endpoints (rule 5).

## Tasks

- [x] T1 `buildSharedMatrix(apps: readonly GraphApp[]): SharedMatrix` in
      `src/core/graph.ts`, exported through `src/core/index.ts`, attached to
      `FederationGraph`. Deterministic: sorted package rows, host-first then
      alphabetical columns, no `Map`/`Set` order leak. Test-first against
      `fixtures/fixture-version-drift` (react: host `19.0.0` vs mini_store
      `19.1.0` ⇒ `drift`), plus determinism, an `unknown`-version case, an
      app with no manifest (all `absent`), and a roster with no host.
- [x] T2 `Compare` view tab in `src/studio/page.ts`: markup + `renderViewTabs`
      + keyboard handler (`VIEWS`) + `renderMatrix()` called from `render()`,
      text nodes only, honest hint about the host-only scope and `unknown`
      never being a pass. `renderShared` stays as-is. Closed by the parent with
      the Studio work-unit commit.
- [x] T3 Tests: `tests/studio/page.test.ts` static guard for the new tab (no
      `innerHTML`, no external load); `tests/e2e/studio.spec.ts` on the drift
      workspace (offending cell is a `bad` pill, hint states host-only scope)
      and on `fixture-xss` (hostile strings render as text inside Compare).
- [x] T4 Docs: `docs/PRD.md` §7.2 layout sentence lists Apps | Compare |
      Doctor; `README.md` Studio section if it enumerates tabs.
- [x] T5 Checks (parent, on the full tree): `pnpm build`, `pnpm typecheck`,
      `pnpm lint`, `pnpm test`, `pnpm agent:check`, and
      `pnpm exec playwright test tests/e2e/studio.spec.ts`.
- [ ] T6 Close: work-unit commit(s); native review per RDD over the resulting
      candidate (a work-unit commit, not the branch).

## Evidence log

(append commits, outputs, review lineage ids here)

- Issue created: #73 (`type:feature`), read back from the target host, body
  matches byte-for-byte after CRLF/trailing-newline normalization.
- Branch `feat/studio-shared-matrix` created at `d147683`.
- T3/T4 (tests + docs, no `src/**` change). Payload proven first, over the
  compiled preview (`node tools/studio-preview.mjs --workspace
  fixtures/fixture-version-drift --port 8159` → `GET /api/graph`):
  `referenceApp: "host"`, `apps: ["host","mini_auth","mini_store"]`, react
  cells `reference 19.0.0 / match 19.0.0 / drift 19.1.0`, react-native all
  `match 0.79.2`. Over `fixtures/fixture-xss` the hostile package name
  `"><svg onload=alert(3)>` is declared by mini_store only, so its cells are
  `absent / absent / uncompared`.
- `tests/studio/page.test.ts`: new
  `describe('Studio page Compare view (shared-dependency matrix)')`, 7 specs
  (tab order, hidden panel + aria wiring, `VIEWS` order, `graph.sharedMatrix`
  → text nodes, status→pill mapping, scope hint, no-data empty state).
  `pnpm exec tsx --tsconfig tsconfig.test.json --test tests/studio/page.test.ts`
  → `tests 30 / pass 30 / fail 0`.
- Guard-strength check (in-memory string mutations of the page, no writes):
  renaming the compare tab id, dropping `hidden` from the panel, removing
  `'compare'` from `VIEWS`, mapping `unknown` to the `ok` pill, and deleting
  the remote-vs-remote sentence each FIRE at least one new guard.
- `tests/e2e/studio.spec.ts`: new
  `describe('Studio Compare view (shared-dependency matrix)')` (6 specs, drift
  preview on `basePort + 61`) plus one Compare XSS spec inside the existing
  rendering-probe describe. No existing spec needed a change for the third
  tab: the old assertions name views by id (`#view-apps`, `#view-doctor`) and
  never asserted a two-tab count. `pnpm exec playwright test
  tests/e2e/studio.spec.ts` → `28 passed (5.3s)`.
- First real failure observed while writing the specs (kept as the closest
  thing to RED here, since the behaviour already existed): asserting the
  matrix headers as `['Package','Singleton','host',…]` failed with
  `Received ["PACKAGE","SINGLETON","HOST",…]` — `table.kv th` is
  `text-transform: uppercase`, so the spec compares case-folded.
- T4: `docs/PRD.md` §7.2 layout bullet now reads **Apps | Compare | Doctor**
  and states the matrix scope (host column is the reference, host-vs-app only,
  `unknown` never a pass, still read-only). `README.md` was not touched: it
  does not enumerate the Studio tabs.
- T1 RED observed before GREEN: with `src/core/graph.ts` reverted to `HEAD`, the
  focused run failed with `SyntaxError: The requested module
  '../../src/core/index.js' does not provide an export named
  'buildSharedMatrix'`; after the implementation the same command reported
  `tests 27 / pass 27 / fail 0`.
- Discovery while writing the no-host test: `buildFederationGraph` ALWAYS
  synthesises a host node (`hostName` falls back to the literal `host`), so a
  graph never lacks the column — what it can lack is a host *manifest*. The
  test asserts that reality; the genuinely hostless roster is covered by
  calling the pure `buildSharedMatrix` directly.
- Defect found reviewing my own slice, then fixed: the `Singleton` column
  printed `no` for a package only a REMOTE declares as singleton, because the
  row flag is the reference declaration. `SharedMatrixRow` gained
  `referenceDeclares` and the page now prints `not on host` instead of a claim
  the data does not support (rule 7). Exercised by the real `fixture-xss`,
  whose hostile package is remote-only:
  `"><svg onload=alert(3)> | not on host | — | — | no reference 1.0.0` with
  `dialogs: []`.
- T5 full battery observed on the branch: `pnpm build` clean; `pnpm typecheck`
  clean; `pnpm lint` clean (`$ eslint .`, no output); `pnpm test` →
  `tests 930 / pass 930 / fail 0`; `pnpm exec playwright test
  tests/e2e/studio.spec.ts` → `28 passed (6.3s)`; `pnpm agent:check` →
  `agent-sync --check OK: 5 skills in sync`.
- T6 commits: `55fe46c` feat(core) (core matrix + its tests, 458 lines), then
  the Studio view + its tests + PRD §7.2. Review-size note: the whole branch is
  over the 400-line PR budget, so it ships either as two chained PRs or as one
  PR carrying `size:exception` (the route #68 took). The user decides.
- Native review (RDD on): candidate = both commits of this branch as one
  target (base `d147683`, committed-only). Lineage `review-9e6f7f0e773d1179`,
  tier medium (reason `executable_change` in src/core/graph.ts), lens
  `review-reliability`, 1 materialize run (forecast relayed, then
  acknowledged). Capture closed `approved` on the last admitted event
  (store revision `4d5b6f7b…`); the provider-issued `acknowledge-approved`
  ran unchanged and returned `authority: "burned"`,
  `consumed_revision: 4d5b6f7b…`. No findings, no correction round.
  Note: `acknowledge-approved` is a native CLI operation — the `gentle_review`
  facade rejected it as `controller-only-input` before the CLI run accepted it.
