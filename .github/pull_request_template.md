## Issue

Closes #

<!-- Issue-first: work starts when a maintainer applies `status:approved`.
     The linked-issue CI check fails without one of Closes/Fixes/Resolves/Refs. -->

## Description

What changed and why. Keep it to what a reviewer cannot learn from the diff.

## Checks

Paste real output, don't claim a green check you didn't run (AGENTS.md rule 9).

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm agent:check` (if skills or AGENTS.md changed)
- [ ] `pnpm check:vendored` (if `src/repack-bridge/vendored/` or VENDORED.md changed)
- [ ] `pnpm test:e2e` (if Studio behavior changed)

## Checklist

- [ ] PR title follows Conventional Commits
- [ ] Under 400 changed lines, or a maintainer added the `size:exception` label
- [ ] One `type:*` label
- [ ] Commits are reviewable work units (tests + docs with the behavior)
- [ ] **AI disclosure** (AI_POLICY.md): tool/model and material scope of AI
      assistance, or "none"
