# dev TUI render probe (measurements, no conclusion yet)

## Objective

Give the `dev` dashboard a repeatable render measurement so a future "this
feels slow" is answered with numbers. This task adds a probe and records what
it measured on one machine. It deliberately records **no recommendation**: the
user's standing note is that the dashboard does not feel slow today, so there
is nothing to fix until a threshold is actually crossed.

## Context

Reported as "Ink feels slow". Measured instead of argued. Two independent
questions, because they have different causes:

1. **CPU** — what does one painted frame cost (`onRender({ renderTime })`), and
   does it grow with the log buffer?
2. **I/O** — how many bytes does the render layer write per painted frame, and
   what does that scale with?

## Tasks

- [x] T1 `tools/tui-perf.mjs`: dev-only probe. CPU table over a fake 120x40
      stream using the renderer's own `onRender` timing; byte table on the real
      stdout across two terminal sizes. `--with-console` toggles
      `patchConsole` to compare. Exit 2 on bad args or missing build.
      Route: inline (single dev-only file, no src/ touched).
- [x] T2 Record the numbers below and the three retractions, so nobody chases
      a phantom. Route: inline (this file).

Not done on purpose: no issue opened, no `src/` change, no dependency
change. If this ever becomes work, the repo's issue-first rule applies and the
probe's output is the evidence to paste.

## Measurements (2026-10-02, one Linux-less macOS box, ink 6.8.0, react 19.3.0)

Run under a PTY — the render layer may take different paths when
`stdout.isTTY`, so without one the byte table is meaningless:

```
pnpm build && script -q /dev/null node tools/tui-perf.mjs --lines 2000 --frames 10
```

CPU per painted frame (fake 120x40 stream, `patchConsole=false`):

```
  lines   snapshot(ms)   render(ms/frame)   [from the renderer's onRender]
    200        0.007   2.06   (17 painted frames)
   1000        0.016   1.52   (18 painted frames)
   2000        0.037   1.36   (18 painted frames)
```

Bytes per painted frame under load (one new progress line per frame):

```
      80x26     4791 B/frame     184 B/row    2.30 B/cell
     160x53     9069 B/frame     171 B/row    1.07 B/cell
```

One-time cost, behind the seam's dynamic import (never on `--json`/`--ci`):

```
import ink+react: 104-173 ms
```

### What the numbers say

- Buffer size is not the CPU driver. `snapshot()` is the pure model copying the
  selected app's lines: 0.007 → 0.037 ms from 200 to 2000 lines. Painted-frame
  render time is 1.4-2.1 ms and does not rise with the buffer, because the view
  renders a window, not the ring.
- Byte cost scales with viewport **height**, not with what changed. B/row stays
  flat across sizes (184 vs 171) while B/cell falls (2.30 vs 1.07), so a frame
  is repainted per viewport row. A taller terminal pays more for the same
  amount of news. That is a property of the ANSI render layer, not of
  `src/cli/dev-tui/model.ts`.
- Both knobs ink 6.8.0 offers were checked and neither changed the byte
  numbers: `incrementalRendering: true` gave an identical 2784 B/frame in an
  earlier single-size A/B.

### Explicitly not concluded

Whether to move off ink 6 is **not** decided here. For the record, the two
options looked at and why neither is actionable today:

- **ink 7.1.1** rewrote the fullscreen clear/repaint branch upstream. Plausible
  cheap win, but it is a dependency bump against a dashboard that does not
  currently feel slow. Unmeasured.
- **OpenTUI** (`@opentui/react`) repaints only changed cells, but needs Bun
  1.3+ or Node 26.4 with `--experimental-ffi`, against this repo's
  `engines: node >=22.13` and AGENTS.md rule 11. Blocked, not rejected.

## Retracted findings (do not chase these)

Both were bugs in the measuring harness, not in the repo. Verified by
re-running with a corrected stand-in:

- **"two children with the same key" in the dashboard** — false. It appeared
  only because the probe's fake stdin had no `ref()`; ink enables raw mode via
  `stdin.ref()`, its error boundary then rendered an error, and that error's
  own stack trace looked like the duplicated key. Clean stand-in (isTTY,
  `setRawMode`, `ref`, `unref`, `setEncoding`, `setFlowing`) ⇒ 0 warnings.
  Verified both ways: dupKey=1 without `ref()`, dupKey=0 with it.
- **"`patchConsole` inflates a frame from ~1 ms to ~53 ms"** — false, and a
  warning about a bad method: the 53 ms came from dividing total wall time by
  frame count, which folds the 50 ms sleep *between* frames into the average.
  With the renderer's own timing: `patchConsole=false` 1.36-2.06 ms,
  `=true` 1.16-1.92 ms. No meaningful difference.

One code asymmetry is real but cosmetic: the dashboard mount omits
`patchConsole: false` while the wizard's prompt port sets it. Measured impact
≈ 0; file it under consistency, not performance.

## Method notes (why the probe looks the way it does)

Three tempting ways to measure ink frame cost are all wrong:

1. A synchronous burst of `rerender` measures **enqueue** time, because the
   renderer coalesces frames below its own throttle (~1 ms, misleadingly fast).
2. Total wall time ÷ frame count folds the inter-frame sleep into the number
   (~55 ms at a 50 ms spacing, misleadingly slow — this is the trap above).
3. Timing the `rerender` call alone still misses work done after it returns.

The probe therefore reports the render layer's own `onRender({ renderTime })`.
Note that its frame count can exceed `--frames` (mount and trailing frames
count), which the table labels.

## Checks

`node --check tools/tui-perf.mjs`; `node tools/tui-perf.mjs --help`; PTY run
above with the output pasted here. `pnpm build` before running (it loads
`dist/`). Not wired into CI on purpose: terminal throughput is machine-,
terminal- and load-dependent, so a gate here would only create flakes.

## Incident note

The first version of this probe was written into the primary worktree and
deleted mid-session: another agent session was running checkouts and cherry-picks
in the same working tree at 15:01-15:02. This copy lives in the isolated
worktree `forks/wt-tui-perf` on branch `chore/dev-tui-render-probe` from
`origin/main`. Anyone measuring here should not write into a tree another
session is rebasing.

## Progress

- Worktree: `forks/wt-tui-perf`, branch `chore/dev-tui-render-probe` from
  `origin/main` (d7fe4bc). `node_modules` is a local symlink, excluded via
  `.git/info/exclude`, never committed.
- T1 + T2: `tools/tui-perf.mjs` + this file, one work-unit commit.
- Evidence observed on this branch:
  - `node --check tools/tui-perf.mjs` OK; `--help` prints.
  - `eslint tools/tui-perf.mjs` and `eslint .`: clean (the probe imports
    `Buffer`/`performance`/`setTimeout` from `node:` builtins instead of
    widening the shared `atlas/scripts` globals block).
  - `tsc -p tsconfig.test.json --noEmit`: OK.
  - `node:test` full suite: **794 passed, 0 failed** (15.8 s).
  - `node scripts/commit-check.mjs --range origin/main..HEAD`: OK.
  - PTY probe run: `2.14 ms` painted frame at 200 lines; `4525 B/frame
    (174 B/row)` at 80x26 vs `9069 B/frame (171 B/row)` at 160x53.
  - `pnpm build` / `pnpm test` were NOT usable in this worktree: pnpm's
    dep-status check rejects the local `node_modules` symlink, so `tsc` and
    `tsx` were invoked from `./node_modules/.bin` directly.
- Commit: `ca094da` `feat(dev): add a render probe for the dev dashboard`.
- Native review: lineage `review-f33dc1d79832875b`, tier medium, lens
  `review-reliability`, **approved** and acknowledged (authority burned,
  receipt `gentle-ai.review-acknowledged/v1`, consumed revision
  `sha256:d76bc818…`). Delivery followed ordinary repository policy; the
  review grants it no extra authority.

## Follow-up opened

Tracked as https://github.com/gedu/repack-atlas/issues/64: whether the ink 6
fullscreen repaint is worth acting on, with the numbers above, the conditions
that should reopen it, and the open questions (ink 7 spike, whether this probe
gets merged as a standing tool). No fix is scheduled; nothing here blocks
anything.

## Follow-ups from the review (non-blocking, not done here)

The approved receipt stands; these six were all `informational` and opened no
correction, so they are later work, never a reason to re-run review here:

Receipt `R3-001`…`R3-006` reported only id/lens/severity/disposition and a
location (lines 76-108, 85-89, 97-101, 103-106, 182-185, 209-213), no finding
text. The four notes below are those locations read back into the code, so
treat them as the reasonable reading, not a transcript of the reviewer.
- `parseArgv`: `Number('')` and `Number(' 7 ')` are not what they look like —
  `--lines ""` becomes `0` (caught), but `--sizes a,b` filters to `[]` and is
  caught only by the width check, while a partial list silently drops a size.
  Report which value was rejected instead of exiting quietly.
- `stdoutBytesWritten()` returns `0` when the property is absent, which would
  silently report 0 B/frame instead of failing. Prefer an explicit "unavailable"
  over a plausible zero in a probe whose whole job is the number.
- `collectRenderTimes.mean()` returns `NaN` when nothing painted, which prints
  as `NaN` in the table. A painted-frame-count of 0 is exactly the case where a
  probe should say "nothing was measured" loudly.
- Spacing vs the renderer's throttle is the whole method: if `--spacing` drops
  below the renderer's own frame throttle, frames coalesce and the table
  silently lies. Consider warning when `--spacing` looks too small rather than
  trusting the caller to keep the default.

The dashboard `patchConsole` asymmetry (real in code, measured impact ≈ 0) is a
separate consistency nit, unrelated to this probe.
