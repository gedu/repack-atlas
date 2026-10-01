# Feature: `dev` interactive TUI dashboard (ink)

## Objective
Replace the flat, interleaved `[app] line` scroll of `repack-atlas dev` (human
TTY mode only) with an interactive dashboard: a sidebar listing the host, every
remote and the one-shot `launch`, selectable with keys, and a main panel showing
the selected app's log. Status icons (starting / ready / error / exited /
stopped), colors, and live spinner-frame collapsing (the repeated
`- Building the app....` lines must render as ONE updating line, not 25).

## Problem
The supervisor multiplexes 5 children through pipes; children lose their TTY so
they emit every spinner frame as a new line and drop colors. Interleaved raw
lines are unreadable in a demo. The supervisor already emits the perfect data
(`onLog(app, stream, line)`, `onStatus(app, status, port, pid)`,
`onOneShot(name, event)`); this is a render layer in `src/cli/` only.

## Why
Live demo quality ("it really looks like it's loading") and everyday legibility
of `dev`.

## Constraints (hard)
- Machine paths are UNTOUCHED: `--json`, `--no-interactive`/`--ci`, `--dry-run`,
  the plan/studio/app/exit event stream, exit codes 0/1/2, the wizard (runs
  BEFORE the TUI takes the screen), Studio SSE notify, shutdown plumbing
  (q / Ctrl-C / SIGINT / SIGTERM → ordered shutdown once).
- TUI renders ONLY when human-interactive: TTY stdin+stdout, no `--json`, no
  `--ci`. Non-TTY keeps the current plain prefixed-line rendering exactly.
- User-approved exception to AGENTS.md rule 11: `ink` (+ its `react` peer) as
  runtime dependencies. Rule 11 text MUST be updated in the same commit to name
  ink/react as the second sanctioned exception, scoped to the dev TUI, loaded
  lazily so non-TTY paths never import them. Keep it confined behind the CLI
  render layer (no core/runner imports of ink/react).
- Log volume bound: per-app ring buffer (cap ~2000 lines, keep last), no
  unbounded growth.
- Conventional Commits, no AI attribution; one work-unit commit per task.

## Accepted changes to existing behavior (human TTY path only)
- Spinner/progress frame collapsing: consecutive lines from one app matching a
  spinner pattern (repeated trailing dots on identical text, braille/box
  spinner glyphs, `[====---] NN%` progress bars sharing a label) collapse to
  one live line that updates in place and settles as a final line.
- Status line colors: ready green tick `✓`, starting amber `●`, error/exited
  nonzero red `✗`, stopped dim `○`, one-shot finished `→`.

## Scope (files)
- `package.json` — deps: `ink`, `react`; devDeps: `@types/react`. tsconfig
  `jsx: react-jsx` (src tsconfig + test tsconfig if needed).
- `src/cli/dev-tui/model.ts` — PURE view-model: per-app ring buffer, frame
  collapsing, status→icon/color mapping, selected-app navigation. No ink/react
  imports (unit-testable with node:test).
- `src/cli/dev-tui/app.tsx` — ink components: sidebar (apps + icons + ports),
  main log panel (selected app, autoscroll, scrollback keys), keymap
  (↑↓/j-k select, PgUp/PgDn or arrows-in-panel scroll, tab cycle, v/o studio,
  q/Ctrl-C quit), alt-screen + cursor hidden, resize-safe.
- `src/cli/dev.ts` — render seam: when interactive, route `onLog`/`onStatus`/
  `onOneShot` into the model and render the TUI instead of plain writes;
  wizard still runs first with prompts on the normal screen; the plan table /
  warnings print BEFORE the TUI mounts; on TUI exit, continue with the existing
  shutdown path and exit-code logic. Dynamic-import the TUI module so
  non-TTY/JSON runs never load ink/react.
- `AGENTS.md` — rule 11 update (second exception: ink+react, dev TUI only,
  lazy-loaded) and layout note (`src/cli/dev-tui/`).
- `tests/cli/dev-tui-model.test.ts` — collapsing, ring buffer, navigation,
  status mapping.
- Existing suites must stay green (`tests/cli/*`, `tests/runner/*`).

## Authorized scope
Branch `feat/dev-tui` (created from main @ 791ec00). Only the files above.

## Acceptance criteria
1. `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test`
   green (paste real output).
2. `dev --json` / `--dry-run` / `--no-interactive` output byte-identical in
   shape to before (existing CLI tests prove it).
3. `node dist/cli.js dev` in a real terminal shows sidebar + panel; selecting
   an app swaps the log; spinner floods render as one updating line.
4. ink/react are not imported when `--json` is used (assert via a test or
   documented dynamic-import check).

## Checks (exact commands)
```
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## Route
Delegated single writer (writer trigger: 6+ non-trivial files). One task at a
time with work-unit commits; long-session backstop applies.

## Tasks
- [x] T1 — Deps + config + rule update: add ink/react/@types/react, tsconfig
      jsx, rewrite AGENTS.md rule 11 + layout; verify a one-off ink render
      smoke under tsx. Commit `chore(dev): add ink for the interactive dev TUI`.
- [x] T2 — Pure view-model `src/cli/dev-tui/model.ts` + tests
      (`tests/cli/dev-tui-model.test.ts`). Commit
      `feat(dev): add pure TUI view-model with spinner collapsing`.
- [x] T3 — ink app `src/cli/dev-tui/app.tsx` (sidebar + panel + keys). Commit
      `feat(dev): render dev dashboard TUI with sidebar and log panel`.
- [x] T4 — `src/cli/dev.ts` seam: interactive gate, lazy import, wizard-first,
      plain path untouched; smoke `dev --json` unchanged + real-terminal run
      noted. Commit `feat(dev): mount the TUI for interactive dev sessions`.

## Next step
T5: full checks done by T4 writer (618/618). Remaining: user real-terminal
smoke (`node dist/cli.js dev` in fixtures/workspace or the showcase).
- T5 checks @ `b76c2f9`: parent spot-check re-ran `pnpm test` → 618/618 pass.
  `review assess --base-ref 791ec00 --committed-only` → medium,
  slice_budget_reached (2284 lines, 13 paths). Native review START refused
  deterministically (provider defect, upstream issue #4749 occurrence filed
  2026-10-01); verification stands as writer self-verification + parent spot
  check. Boundary not advanced (no receipt).
- [ ] T5 — Full checks (`pnpm install/build/typecheck/lint/test`), paste
      output, fix fallout, docs touch in `docs/` only if `--help` text changes
      (help gains a line noting the interactive dashboard). Commit
      `fix(dev): TUI review fallout` if needed, else fold into T4.

## Progress / evidence
- T1 done @ `61a55f8`: ink ^6.8.0 + react ^19.2.0 (+@types/react devDep),
  tsconfig `jsx: react-jsx` + include `src/**/*.tsx` (both tsconfigs),
  AGENTS.md rule 11 rewritten (two exceptions) + layout entry. Observed:
  build/typecheck/lint exit 0; `pnpm test` 576/576 pass; ink JSX smoke via
  tsx printed `hello` exit 0. Gotcha: JSX smoke must live INSIDE the repo
  (node can't resolve react from /tmp).

## Next step
Launch the writer for T4 (dev.ts seam: interactive gate + lazy mount).

- T3 done @ `189f6c1`: app.tsx + 7 tests (ink-testing-library devDep; test
  script now also globs tests/**/*.test.tsx). Observed: typecheck/lint/build
  exit 0; `pnpm test` 609/609. Seam API: `DevTuiAppProps {model, onQuit,
  onOpenStudio?}`; mount via `ink.render(..., {exitOnCtrlC:false})`; 100ms
  tick re-snapshot (seam just feeds the model); keys handled inside. Note:
  one-time React dev-mode key warning traced to ink's useInput internals.

- T2 done @ `1f3a39f`: model.ts (478 lines, pure, type-only imports) + 26
  tests. Observed: typecheck/lint exit 0; `pnpm test` 602/602 pass (was 576).
  API: createDevTuiModel({apps,launchName?,ringCap?}); log/status/oneShot
  return boolean (unknown app rejected); STATUS_PRESENTATION glyph+color;
  collapseCandidate + classifyLine exported; snapshot()/visibleRows() for a
  dumb UI; navigation clamps; caller passes `at` (no Date in model).

## Follow-up: first real-terminal smoke (user, 2026-10-01)
Smoke PASSED visually ("se ve bien"), five feedback items → follow-up tasks:
- [x] F1 — Mouse wheel over the log pane selects sidebar rows. Routing the
      wheel by pointer position needs mouse-tracking capture (SGR 1006),
      which would break native copy/paste. Minimum fix: wheel must never
      change app selection; keyboard scroll (PgUp/PgDn) already exists.
      Consider capturing wheel → log scroll ONLY behind a toggle key that
      also warns copy needs a modifier; decide simplest honest option.
- [x] F2 — Copy grabs the sidebar too because rows are padded to the full
      sidebar width. Drop the full-width blank pad + `│` gutter glyph so a
      log-pane drag/selection yields clean log lines (no sidebar text, no
      `│` artifacts). Full-row drag across both panes stays possible (user
      should start the drag inside the panel); document in help/footer.
- [x] F3 — `- Building the app...` live line: animate the dots growing and
      shrinking (1→6→1) on the 100ms tick while the line is `live: true`,
      instead of a single frozen settled frame.
- [x] F4 — Progress bar pinned to the BOTTOM of the log panel: newest
      progress frame renders as the last visible line while active; later
      plain lines render ABOVE it so it is never buried; terminal
      (Compiled/success/error) releases the pin. Bar must reach 100% (do
      not truncate the final frame; if the child's last bar frame is <100
      but a terminal line follows, render one synthetic 100% frame — mark
      it clearly not-fabricated? No: only normalize the BAR GRAPHICS to
      full when percent says 100; never invent a completion the child did
      not print — the Compiled line is the completion signal).
- [x] F5 — Palette: match Re.Pack's console reporter (verified from
      callstack/repack packages/repack/src/logging): cyan module/issuer
      names, green for success, yellow warn, red error, dim timestamps;
      level words uncolored. Replace the current generic inverse/`live`
      highlight with the Re.Pack-style scheme; keep stderr `!` marker.

## Next step
Delegate F1-F5 as one bounded UI-polish writer (files: app.tsx, model.ts if
pinning belongs there, tests). Then user smoke again.

## Second smoke feedback (user, 2026-10-01) → F6-F12
- [x] F6 — Scroll-up beyond top blanks the panel: logWindow must clamp the
      offset to `max(0, total - pageHeight)` (with the pinned line counted).
- [x] F7 — `Building the app........` (8+ dots) still floods: the collapse
      normalizer tolerates only ≤6 trailing dots; drop that cap for
      dots-only variation. (Two lines in the launch panel differ only by
      8 vs 5 dots and both survived.)
- [x] F8 — Bar never reaches 100%: Re.Pack's child never prints a 100 frame
      (jumps 98% → Compiled). When a terminal line (Compiled/success/error)
      arrives for an active bar, render the bar completed (fill to full,
      percent 100) as the bar's final frame — the build DID complete, this
      re-draws an outcome the child already reported. Un-pin the bar once a
      terminal line follows it (trading showed a pinned 98% bar below
      `Compiled` — the pin must die on terminal lines, not only by
      recency).
- [x] F9 — No Re.Pack colors visible: piped children emit FALLBACK ascii
      symbols (i, !, x, ✓, ->) per repack reporters.ts; LEADING_SYMBOL only
      matches the unicode set, so colored glyphs never triggered. Add the
      ascii fallbacks (leading token before a space). Polish: dim the
      `[hh:mm:ss.SSSZ]` timestamp span, keep messages default foreground.
- [x] F10 — Real-time liveness: sidebar rows show an unread-activity marker
      after the port when logs arrived while the app is NOT selected
      (count + animated ▾ bounce, cleared on select). Creative but subtle.
- [x] F11 — `m` toggles mouse reporting off (native drag-copy without
      Shift, wheel becomes terminal-native) / on; footer reflects state.
      Full-row highlight during native copy is a terminal artifact, not
      ours — document.
- [x] F12 — Typed input: `i` opens a one-line input at the panel bottom;
      Enter sends the line + \n to the SELECTED app's stdin (new lines
      only). Requires: ProcessHandle.writeStdin (core port, additive),
      adapter writes child.stdin (children already spawn piped),
      supervisor.writeAppInput(key|name, line), seam passes a callback
      into the TUI; oneshot 'launch' row has no persistent stdin → input
      disabled for it. Test: stub bundler echoes stdin back to stdout
      (fixtures pattern). Honest caveat: RN CLI reads interactive keys
      only on a TTY stdin; piped lines still reach child.stdin and work
      for any child that reads stdin, but RN's key shortcuts may ignore
      them — report observed behavior, do not promise reload keys work.

## Next step (current)
One bounded writer, two work-unit commits: U1 = F6-F11 (app.tsx/model.ts +
tests), U2 = F12 (ports/adapter/supervisor/dev.ts/TUI + stub test).
COMMIT AFTER EACH UNIT before anything else (workers keep dying mid-report).

### F1-F5 landed (uncommitted worker output finished + verified by parent)
Worker died before reporting; parent verified: 2 real fixes applied by the
parent — stripSpinner left a leading space (test expected trim); SGR mouse
regexes used ESC literals banned by eslint no-control-regex (rebuilt via
String.fromCharCode(0x1b)); splitLeadingSymbol trims the separator space the
renderer re-inserts. Observed: build/lint/typecheck exit 0; pnpm test 638/638
(was 618; +20 new). F1 = DECSET 1000+1006 capture, SGR wheel routed by column
(sidebar=selection, panel=scroll 3 lines), footer notes shift+drag copy.
F4 pin rule: progress-shaped line pinned only while within the last 3 buffer
lines; 100% bar normalization only redraws what the child printed.

### F6-F12 landed
- U1 `f2d8a1d` (F6-F11), U2 `ecf01c5` (F12 typed stdin; ProcessHandle.
  writeStdin optional, supervisor.writeAppInput, `i` prompt; TTY caveat:
  RN CLI reads shortcuts only from a TTY stdin — bytes reach the child,
  effects depend on the child reading stdin).
- Parent spot check: `pnpm test` 663/663 pass (was 638; +25). check:commits
  OK (9 items). Deviation accepted: `! `-prefixed stderr lines settle
  instead of collapsing (warn/error text never swallowed).

## Third round (user, 2026-10-01) — rules review + G-items
Engineering-rules audit: #1 batched render ✅ (100ms tick, seam never renders);
#2 visible-only ✅ (ring + logWindow); #4 flicker ✅ (ink diff), spinner
isolation partial; #5 restore hardening partial (async crash could leave
alt-screen); #6 multi-terminal ❌ (only Ghostty smoke so far); #7 pure logic ✅.
- [x] G1 — Panel-level notice: when scrolled above the bottom, show a dim
      notice line at the panel bottom `↓ N new lines below` (N since
      autoscroll paused), cleared on return to bottom. (rules #3)
- [x] G2 — Sidebar activity badge: keep the bounce glyph, DROP the number
      (user: animation alone is great).
- [x] G3 — Restore hardening: while the TUI is mounted, an
      uncaughtException/unhandledRejection must first unmount, leave
      alt-screen, show cursor, disable mouse tracking, restore stdin, THEN
      rethrow/exit; document SIGKILL leaves the terminal (inherent).
- [x] G4 — Startup banner: centered ASCII art atlas/map glyph in Re.Pack-ish
      colors + `repack-atlas v<x>` + tagline, printed on the NORMAL screen
      before the wizard/supervision (human paths only; --json/--ci/non-TTY
      never print it). Art style: user-supplied braille flower as reference;
      draw a compass/map, keep ≤12 rows, braille/box chars Ghostty-safe.
- [ ] G5 (NEXT CYCLE, after user terminal smoke) — wizard-in-TUI: replace
      clack prompts with selection inside the dashboard (sidebar = apps to
      run). Separate work cycle; touches the prompt gate.

### G1-G4 landed
- `709071b` G1+G2 (notice + numberless badge, 666/666)
- `b64be82` G3 crash-restore guard, handlers registered+removed asserted
  (667/667; real-pty crash smoke = user)
- `40cf6f4` G4 banner: pure banner.ts (pink 38;5;213 dotted globe+compass,
  green poles, bold wordmark, dim tagline), shared version.ts, human TTY
  only (677/677). Parent spot check: pnpm test 677/678->677/677 pass.
### Remaining
- G5 wizard-in-TUI: next cycle, after the user's multi-terminal smoke
  (iTerm2/Terminal.app/tmux/VS Code) and banner/notice visual check.

## Fourth round (user, 2026-10-02) — banner redraw + G5
- [x] B1 — Banner redraw: user supplied braille hot-air balloon art (REPACK
      lettering in the body) as the LITERAL reference. First version kept the
      ≤12-row budget compacted; user instead supplied a compacted 24-row
      variant of their own art and asked for it verbatim. Landed @ `de1f186`:
      banner.ts ART = the user's 24x38 asset byte-for-byte (top crown + the
      five basket/rope rows green, balloon body pink 38;5;213), row-budget
      test locked to exactly 26 rows (art + wordmark + tagline). Observed:
      build/typecheck/lint exit 0; banner suite 8/8 (charset, centering,
      no-ESC-in-plain, SGR-strip equality all still pass); `pnpm test`
      677/677. Real-terminal visual = user smoke.
- [x] G5 — wizard-in-TUI: Landed @ `03dd574` + `84156db`. Architecture:
      dev-wizard.ts already spoke only to PromptPort, so the flow never
      changed — new pure controller `wizard-model.ts` (state machine, purity
      fence like model.ts) + `wizard.tsx` (ink view + createTuiPromptPort,
      normal screen, NO alt-screen; one session for the whole wizard;
      Ctrl-C/Esc sticky-cancel; close() leaves raw mode off + stdin paused
      for the dashboard's takeover). dev.ts routes with ONE hoisted
      `tuiCondition` (wizard port and dashboard can never disagree);
      dynamic import only (rule 11b holds — seam fence extended to list
      wizard.js); render-layer failure degrades to clack/readline. Observed:
      build/typecheck/lint/agent:check/check:commits exit 0; `pnpm test`
      677 -> 733 (+56: pure machine, WizardApp ink render, port hygiene on
      fake streams, seam routing both directions). Caveat (honest): real
      keystroke smoke on iTerm2/Ghostty/tmux is user-owned — ink-testing
      covers the frame, not a pty.
      Note: SDD-dispatched writers were refused (preflight gate); delegated
      via general workers instead. First general worker died twice mid-run
      without committing source; parent verified + committed the work unit
      (03dd574). Second died after committing tests early (84156db); fresh
      audit worker verified 733/733 and found no bugs.

- Native review of the whole slice (`be14f25..b5565a7`, medium, 2292 lines):
  consented by the user, single review-reliability lens, APPROVED and
  acknowledged (authority burned, lineage review-0399083ecba945d7). Two
  non-blocking SUGGESTIONS for later work: (a) wizard-model ask() has no
  guard against a second concurrent call orphaning the first promise
  (sequential-by-port-today); (b) wizard.tsx close() doesn't try/catch
  `instance.unmount()`, so a pathological ink teardown could skip the
  cursor/raw-mode cleanup. Reviewed boundary advanced to `b5565a7`.

### Next step
- User terminal smoke: `node dist/cli.js dev` in the showcase/fixtures —
  balloon banner + ink wizard + dashboard, on Ghostty AND one of
  iTerm2/tmux (the #6 multi-terminal gap from the rules audit is still
  open — no G-item covers it yet).
