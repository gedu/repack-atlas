import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMIT_TYPES,
  validateCommit,
  validateHeader,
  validateIdentity,
  validateMessage,
} from '../../scripts/commit-check.mjs';

const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);

const human = {
  parents: ['a'],
  authorName: 'Edu',
  authorEmail: 'edu@example.com',
  committerName: 'Edu',
  committerEmail: 'edu@example.com',
};

test('accepts every allowed type, with scope and breaking marker', () => {
  for (const type of COMMIT_TYPES) {
    assert.deepEqual(validateHeader(`${type}: add thing`), []);
  }
  assert.deepEqual(validateHeader('feat(core): add thing'), []);
  assert.deepEqual(validateHeader('fix(repack-bridge)!: drop old export'), []);
});

test('rejects an unknown type and a missing summary', () => {
  assert.deepEqual(rules(validateHeader('update stuff')), ['header']);
  assert.deepEqual(rules(validateHeader('wip: half done')), ['header']);
  assert.deepEqual(rules(validateHeader('feat:')), ['header']);
  assert.deepEqual(rules(validateHeader('feat(Core): upper scope')), ['header']);
});

test('rejects a header over 100 characters', () => {
  const header = `feat: ${'x'.repeat(95)}`;
  assert.deepEqual(rules(validateHeader(header)), ['header-length']);
  assert.deepEqual(validateHeader(`feat: ${'x'.repeat(94)}`), []);
});

test('rejects fixup! and squash! commits', () => {
  assert.deepEqual(rules(validateHeader('fixup! feat: add thing')), ['fixup']);
  assert.deepEqual(rules(validateHeader('squash! feat: add thing')), ['fixup']);
});

test('rejects AI attribution trailers in any case', () => {
  const claude = 'feat: add thing\n\nbody\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
  assert.deepEqual(rules(validateMessage(claude)), ['ai-attribution']);
  const lower = 'fix: a bug\n\nco-authored-by: GitHub Copilot <copilot@github.com>';
  assert.deepEqual(rules(validateMessage(lower)), ['ai-attribution']);
  const signed = 'fix: a bug\n\nAssisted-by: ChatGPT gpt-4o';
  assert.deepEqual(rules(validateMessage(signed)), ['ai-attribution']);
});

test('allows human Co-authored-by trailers', () => {
  const message = 'feat: add thing\n\nCo-authored-by: Jane Doe <jane@example.com>';
  assert.deepEqual(validateMessage(message), []);
});

test('rejects "Generated with" banners', () => {
  const claude =
    'feat: add thing\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  assert.deepEqual(rules(validateMessage(claude)), ['ai-attribution']);
  const robot = 'feat: add thing\n\n🤖 Generated with something';
  assert.deepEqual(rules(validateMessage(robot)), ['ai-attribution']);
  const plain = 'feat: add thing\n\nGenerated with Cursor';
  assert.deepEqual(rules(validateMessage(plain)), ['ai-attribution']);
});

test('does not flag ordinary prose mentioning generated code', () => {
  const message = 'feat: add thing\n\nThe generated types are checked in.';
  assert.deepEqual(validateMessage(message), []);
});

test('rejects AI author and committer identities', () => {
  assert.deepEqual(
    rules(validateIdentity('author', 'Claude', 'noreply@anthropic.com')),
    ['ai-author'],
  );
  assert.deepEqual(
    rules(validateIdentity('committer', 'Dev', 'copilot@users.noreply.github.com')),
    ['ai-committer'],
  );
  assert.deepEqual(validateIdentity('author', 'Edu', 'edu@example.com'), []);
});

test('allows the GitHub web-merge committer only as committer', () => {
  assert.deepEqual(validateIdentity('committer', 'GitHub', 'noreply@github.com'), []);
});

test('validateCommit combines message and identity rules', () => {
  const bad = validateCommit({
    ...human,
    authorName: 'Claude',
    authorEmail: 'noreply@anthropic.com',
    message: 'update stuff',
  });
  assert.deepEqual(rules(bad), ['header', 'ai-author']);
  assert.deepEqual(validateCommit({ ...human, message: 'feat: fine' }), []);
});

test('skips merge commits entirely', () => {
  const merge = validateCommit({
    ...human,
    parents: ['a', 'b'],
    authorName: 'Claude',
    message: "Merge branch 'main' into feature",
  });
  assert.deepEqual(merge, []);
});
