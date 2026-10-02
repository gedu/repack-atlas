# Warn before asking busy ports + kill orphan Atlas dev servers (A + C)

## Objective
When `repack-atlas dev` hits busy ports, the user learns it only AFTER the
whole wizard (allocation runs post-wizard). Two upgrades, user-approved
2026-10-02 after a real incident (four orphaned `react-native start` from a
crashed Atlas session held 8081/9001-9003 for 9h+):

- **A — warn inside the wizard**: when the wizard opens a port question,
  probe the default; if busy, say so in the question itself
  (`Use port 8081 for host? (in use: node …/react-native/cli.js start)`).
- **C — offer to kill only recognizable orphans**: on a conflict, name the
  owning process (PID + command). Offer kill ONLY when the owner is
  identifiable as an orphaned dev server of THIS workspace (PPID 1, argv
  matching an app dir of this workspace's react-native CLI). Never a blind
  "kill whatever holds the port". After kills, retry allocation once.

## Problem / why
Wizard UX dead-ends: seven questions, then four conflicts and no path out
besides manual `lsof`/`kill`. `--auto-ports` exists but reassigns when the
user WANTS that exact port (Metro expectations). Orphans exist because a
hard parent death (client crash) leaves spawned children parentless.

## Scope
- Human interactive paths only (wizard + human dev). `--json` / `--ci`
  behavior unchanged byte-for-byte (same conflict lines, exit 1).
- New probe capability lives behind a core/runner-owned port + adapter
  (wrapper rule 3: process spawning is wrapped; ProcessRunner already owns
  isPortBusy/findFreePort — extend it there).
- No new runtime dependencies (rule 11). Owner lookup via `lsof`/`ps`
  spawn through ProcessRunner; where the OS can't answer (e.g. Windows),
  degrade to "busy, owner unknown" (A shows no owner, C offers nothing).
- Kill confirmation through PromptPort (works in TUI wizard + clack +
  readline for free). One question per conflicting port; decline keeps the
  old error path untouched.

## Constraints
- Core boundary (rule 2) untouched; all new code in src/runner/,
  src/adapters/, src/cli/.
- Exit codes (rule 6): a killed-orphan-then-clean-run returns 0 like any
  clean run; refusing every kill keeps EXIT_FOUND_ERRORS (1).
- Honesty (rule 7): only claim "Atlas dev server" when the argv actually
  matched this workspace's app dirs.

## Tasks
- [ ] T1 — Owner probe: extend the process-runner adapter with
      `portOwner(port): Promise<{ pid, ppid, command } | null>` (lsof
      -nP -iTCP:<p> -sTCP:LISTEN → ps for command). Declare the shape as a
      port type in src/runner. Unit tests with a fake ProcessRunner +
      canned lsof/ps output (no real sockets). Commit.
- [ ] T2 — Wizard warning (A): wizard context takes an optional probe;
      port questions probe the default and append the in-use note (owner
      command, trimmed). Busy default + answer "yes" stays allowed (the
      allocator still decides; --auto-ports may move it). Tests via
      fake-prompts. Commit.
- [ ] T3 — Orphan kill (C): on plan portConflict in the human path, for
      each conflicting port resolve the owner; orphan-of-this-workspace =
      PPID 1 AND command contains an app dir of this config workspace.
      Ask kill per owner via PromptPort (show PID + command), SIGTERM,
      wait for the port to free (bounded), retry allocation ONCE. Pure
      matcher + flow tests (fake probe + fake prompts). Commit.
- [ ] T4 — Full checks: pnpm build/typecheck/lint/test, paste outputs;
      update this doc + engram mirror. Commit (docs).

## Verification (every task)
- `pnpm build && pnpm typecheck && pnpm lint` exit 0
- `pnpm test` full suite green (baseline 738)
- `pnpm test -- grep`-style focused suites for the touched area while
  iterating (node:test via tsx)

## Route
Delegated (writer trigger: 2+ non-trivial files; mapping trigger: 4+ files).
TDD mode: not explicitly enabled for this project; repo convention =
node:test suites alongside behavior.

## Evidence
- T1–T3 landed as three work units on feat/dev-port-ux (stacked on
  feat/dev-tui @ e776221): `8891d4a` owner probe (ports types +
  port-owner.ts adapter + parsers), `3f5f9d0` wizard "(in use: …)" note,
  `e4835f0` orphan kill flow + dev.ts gate + seam tests.
- First delegated writer died mid-run (empty result, nothing committed);
  parent verified + fixed its tree (one unused import), then a fresh
  test-writer completed the suite and committed all three units.
- Observed: pnpm build/typecheck/lint exit 0; `pnpm test` **794/794**
  (baseline 738 + 56 new); pnpm check:commits OK.
- Native review (medium, 1924 lines, base e776221): consented, single
  review-reliability lens, **APPROVED**, acknowledged, authority burned
  (lineage review-ec139f207a433c42). Reviewed boundary = e4835f0.
- Non-blocking follow-ups (recorded in review-followups, not fixed here):
  1. WARNING — partial-kill stale error: if several orphans are killed but
     one port never frees, earlier kill notes are dropped and the OLD
     "port X busy" lines print for ports already freed (misleading once;
     next run works). src/runner/orphan.ts.
  2. SUGGESTION — runCommand subscribe outside try/catch: a throwing
     handle hangs until the 2s timeout instead of settling immediately.
     src/adapters/port-owner.ts.
- Env note: an untracked tests/tmpbench/bench.test.ts (+ stuck tsx from a
  dead session) hung the suite mid-run; moved to
  /tmp/opencode/preserved/tmpbench, not deleted.

## Next step
T1–T4 done; feature closed pending user smoke: trigger a real orphan (kill
-9 the Atlas dev parent) and re-run `dev` on the showcase → wizard shows
"(in use: …)" and the offer kills the orphan, retries, goes live. Delivery
(push/PR against feat/dev-tui) is user-owned.
