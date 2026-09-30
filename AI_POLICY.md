# AI Policy

AI-assisted contributions are welcome here. The human submitter owns the
submission, full stop. This policy adapts the
[gentle-ai AI_POLICY](https://github.com/Gentleman-Programming/gentle-ai)
(MIT); wording is ours, the principles are theirs.

## Human responsibility

AI use does not transfer authorship, accountability, or legal responsibility.
By opening a PR you take responsibility for:

- the security, correctness, and maintenance of the whole submission;
- every change, claim, and test result in it;
- licensing and provenance of anything you pasted in;
- being able to explain the design, the implementation, and the tradeoffs in
  review.

A reviewer may ask you to explain any line, or to justify why a change is
proportionate to the problem. If you cannot explain or defend it, the PR gets
rejected, and that is the correct outcome, not a punishment.

## Disclosure

Material AI assistance must be disclosed in the PR declaration (the template
has a line for it): the tool or model if known, roughly what it produced, and
what you did to verify it. "Material" covers code, tests, docs, design,
prompts, skills, and substantive review or investigation.

Trivial help does not need a declaration: formatting, spelling, autocomplete
suggestions, search and navigation.

Raw prompts and chat logs are not required by default.

## Attribution

AI tools receive no human attribution. No `Co-Authored-By`, `Reviewed-by`,
`Tested-by`, `Signed-off-by` or equivalent credit for a model or tool, in
commits or anywhere else. This is a hard rule enforced in review
and by CI (AGENTS.md rule 8); the PR declaration above is the only place AI
involvement is recorded.

## Submission quality

Review looks at the submission, not at whether it "smells like AI". Before you
propose a fix, find the underlying cause and the invariant it broke, then make
the smallest change that restores it. Specifically rejected here:

- output you have not read;
- claims about checks you did not run (AGENTS.md rule 9: paste real output);
- invented APIs, paths, evidence, or test results;
- symptom-masking that leaves the real invariant broken;
- scope creep beyond the approved issue;
- pasted content with unclear provenance or license;
- pushing the work of understanding your own PR back onto maintainers.

## Enforcement

Attribution is checked automatically: CI (`pnpm check:commits`) fails a PR
whose commits carry an AI attribution trailer, a "Generated with" banner, or an
AI tool as author or committer. Human `Co-authored-by` trailers are fine.

Disclosure and everything else stay a matter of review judgment and documented
review decisions. No automated AI detection, no automated disclosure gate.
