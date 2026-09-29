---
name: agent-skills-sync
description: >-
  Keep the multi-agent surface consistent after touching any skill: run the sync
  script to rebuild .claude/skills symlinks and regenerate the AGENTS.md skills
  and auto-invoke tables, and run the check mode the CI agent-files job uses.
  Trigger: after creating or modifying a skill; skill missing from the AGENTS.md
  table; agent-files or agent-sync --check failing in CI; adding a new skill
  directory.
metadata:
  auto_invoke:
    - "creating or modifying any file under .agents/skills/"
    - "adding or renaming a skill directory"
    - "fixing a failing agent-files CI job"
---

# Skill sync

Canonical skills live in `.agents/skills/<name>/SKILL.md`. Everything else is
derived: `.claude/skills/<name>` symlinks (Claude Code does not read
`.agents/skills`) and the two generated tables in `AGENTS.md`. Codex, Cursor,
VS Code and Apex read `.agents/skills` natively, so no adapter is needed for
them — never hand-write copies per tool, copies drift.

## After any skill change

```bash
pnpm agent:sync    # repair symlinks + regenerate AGENTS.md tables
pnpm agent:check   # same work in verify mode; exits 1 on drift
```

`agent:sync` is idempotent and safe to re-run. Commit its `AGENTS.md` changes
with the skill change; do not commit a skill without it.

## What must be true in a SKILL.md

The script parses frontmatter with a minimal reader and validates it the way the
agent runtimes do:

- `name` present, equal to the directory name, matching `^[a-z0-9]+(-[a-z0-9]+)*$`.
- `description` present and ≤ 1024 characters, and it must contain the trigger
  wording (`Trigger: ...`) — agents do not reliably auto-invoke from prose alone.
- `metadata.auto_invoke:` a list of action strings. Each entry becomes a row in
  the AGENTS.md auto-invoke table ("When performing X, ALWAYS load skill Y
  first"), so phrase entries as actions an agent recognises while working, e.g.
  `"modifying src/repack-bridge/**"`.
- Body: concrete steps, no background essays.

Supported frontmatter shapes: single-line values, folded `>-` descriptions, and
`auto_invoke` as either a block list (`- "item"`) or an inline flow list
(`[a, b]`).

## Adding a new skill

1. `mkdir -p .agents/skills/<name>` and write `SKILL.md` (name must match the
   directory).
2. `pnpm agent:sync`.
3. `git status` should show the new symlink under `.claude/skills/` and a
   modified `AGENTS.md`. If `AGENTS.md` did not change, the skill was not picked
   up — fix the frontmatter before moving on.
4. `pnpm agent:check` to confirm.

## CI

The `agent-files` job runs `pnpm agent:check`, which fails when a skill lacks its
symlink, the generated tables drifted, or a SKILL.md fails validation. Reproduce
locally with the same command; the script resolves the repo root from its own
file, so it works from any cwd:

```bash
cd /tmp && node /absolute/path/to/repack-atlas/scripts/agent-sync.mjs --check
```

Never edit text between the `<!-- BEGIN/END auto-generated ... -->` markers by
hand — the next sync overwrites it. If the table content is wrong, fix the
frontmatter it is generated from.
