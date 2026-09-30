# Contributing to Repack Atlas

Thanks for being here. This repo is deliberately small and deliberately strict
about a few things; this document explains the rules and, more importantly,
how to reproduce every CI check on your machine.

## Issue first

Work starts from an issue, not from a PR.

1. Open an issue (bug or feature template).
2. Wait for a maintainer to apply `status:approved`. Approved, unclaimed work
   carries `up-for-grabs`.
3. Only then open a PR that links the issue: `Closes #N` (or `Fixes`,
   `Resolves`, `Refs`). The PR body check fails without one.

This exists because review bandwidth is the scarcest resource here (PRD §11,
risk R3). An approved issue means the design conversation already happened.

## Dev setup

```bash
# Node >= 22.13, pnpm >= 10 (exact version in package.json packageManager)
pnpm install
pnpm build     # tsc: src -> dist; the CLI and fixture tests run against dist/
pnpm test      # 274 node:test tests over the fixture workspaces, seconds
```

## Commits and PR size

- **Conventional Commits**: `type(scope): imperative summary`, where type is
  one of `feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert` and
  the header is at most 100 characters. The PR title and every commit in the
  PR must match, and `fixup!`/`squash!` commits must be squashed first. CI
  enforces this with `scripts/commit-check.mjs`.
- **No AI attribution.** No `Co-Authored-By` (or `Reviewed-by`, `Signed-off-by`,
  ...) trailer naming an AI tool, no "Generated with" banners, and no AI tool
  as commit author. CI rejects them; human co-authors are fine. See
  [AI_POLICY.md](AI_POLICY.md).
- Check locally before pushing: `pnpm check:commits` (commits since
  `origin/main`), `pnpm check:commits --range <base>..<head>`, or
  `pnpm check:commits --message "feat: add thing"` for a PR title.
- **Work units**: each commit is reviewable on its own, with its tests and doc
  updates in the same commit.
- **400-line budget**: PRs must stay under 400 changed lines
  (additions + deletions). Above that, split into chained PRs or ask a
  maintainer for the `size:exception` label. CI computes the number with
  `git diff --numstat` (ignoring `pnpm-lock.yaml`) and fails otherwise.
- Add exactly one `type:*` label.

## Exit codes and JSON output

Every command follows the same contract (AGENTS.md rule 6):

- `0` clean, warnings allowed
- `1` ran and found errors
- `2` could not answer

`1` and `2` must never collapse into each other. Everything user-visible has a
`--json` twin with an `exitCode` field mirroring the process exit code. If you
add a finding, add a fixture variant for it too (skill:
`atlas-doctor-finding`).

## Adding a skill

Skills are how this repo teaches agents (and humans) its conventions.

1. Create `.agents/skills/<name>/SKILL.md` with frontmatter: `name` (matching
   the folder), `description` (the trigger text, <= 1024 chars), and optional
   `metadata.auto_invoke` rows.
2. Run `pnpm agent:sync`. It creates the `.claude/skills/<name>` symlink and
   regenerates the AGENTS.md tables between their marker comments.
3. Commit the skill, the symlink, and the AGENTS.md diff together. CI runs
   `pnpm agent:check` and fails on any drift.

## What CI runs, and how to reproduce it

CI is split to keep a public repo cheap on Actions minutes:

- `.github/workflows/ci.yml` is the **light** CI. Every PR and every push to
  `main` runs one Linux / Node 22 job with the steps below.
- `.github/workflows/ci-full.yml` is the **full** CI: the build-and-test matrix
  (macOS Node 22 + 24, Linux Node 24) and the Studio e2e job. It runs only when
  a maintainer adds the `ready-to-merge` label to the PR (the label must exist
  in the repo) or triggers it by hand with `workflow_dispatch`. A skipped full
  job means "not requested yet", not "passed": add the label and wait for it
  to go green before merging.
- `.github/workflows/pr-checks.yml` holds the PR gates (title, commit
  messages, size, linked issue).

Every job step maps to one local command. All outputs below are from this
checkout, observed 2026-09-30.

| CI step | Local command | Observed result |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | lockfile is committed; keep it in sync with package.json |
| Lint | `pnpm lint` | silent, exit 0 |
| Typecheck | `pnpm typecheck` | silent, exit 0 |
| Build | `pnpm build` | silent, exit 0 (`src` -> `dist`) |
| Test | `pnpm test` | `tests 274 / pass 274 / fail 0` |
| Agent files | `pnpm agent:check` | `agent-sync: OK ...`, exit 0 |
| Vendored provenance | `pnpm check:vendored` | `vendored-check: OK - 6 vendored file(s) accounted for in VENDORED.md` |
| Commit messages (PR gate) | `pnpm check:commits` | `commit-check: OK - N item(s) checked` |
| Studio e2e | `pnpm test:e2e` | `7 passed`, needs `pnpm exec playwright install chromium` |

Two gotchas when reproducing locally:

- **Stale Studio server**: `playwright.config.ts` reuses an existing server on
  port 8099 outside CI (`reuseExistingServer: !process.env.CI`). If a previous
  `dev` or preview run is still listening, kill it before trusting e2e output:
  `lsof -ti :8099 | xargs kill`.
- **`pnpm test` rebuilds first**: `pretest` runs `pnpm build`, because CLI
  tests spawn `dist/cli.js` against the fixtures.

## The architectural fences

ESLint enforces two rules that look like noise until they save you:

- **Bridge fence**: nothing outside `src/repack-bridge/**` may import anything
  under `**/vendored/**`.
- **Core boundary**: `src/core/**` never imports the bridge, adapters, or any
  bundler package.

If one of them fires on your change, the fix is almost always to move code to
the right layer, not to add an ignore. PRs that weaken a guard to pass CI get
closed.

## PR checklist

The template at `.github/pull_request_template.md` is the checklist. The two
items people skip: paste real output for checks you claim passed (AGENTS.md
rule 9), and disclose material AI assistance per AI_POLICY.md.
