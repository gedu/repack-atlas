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
  const claudeTrailer = 'feat: add thing\n\nbody\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
  assert.deepEqual(rules(validateMessage(claudeTrailer)), ['ai-attribution']);
  const lower = 'fix: a bug\n\nco-authored-by: GitHub Copilot <copilot@github.com>';
  assert.deepEqual(rules(validateMessage(lower)), ['ai-attribution']);
  const assisted = 'fix: a bug\n\nAssisted-by: ChatGPT gpt-4o';
  assert.deepEqual(rules(validateMessage(assisted)), ['ai-attribution']);
});

test('allows human Co-authored-by trailers', () => {
  const message = 'feat: add thing\n\nCo-authored-by: Jane Doe <jane@example.com>';
  assert.deepEqual(validateMessage(message), []);
});

test('rejects "Generated with" banners', () => {
  const banner =
    'feat: add thing\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  assert.deepEqual(rules(validateMessage(banner)), ['ai-attribution']);
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

test('allows the GitHub web-merge committer', () => {
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

test('does not flag humans whose name contains a tool word', () => {
  assert.deepEqual(validateIdentity('author', 'Claude Martin', 'claude@example.com'), []);
  assert.deepEqual(validateIdentity('author', 'Codex Rivera', 'cr@example.com'), []);
  assert.deepEqual(validateIdentity('author', 'Jules Verne', 'jules@example.com'), []);
});

test('rejects AI identities by exact name, model name or bot email', () => {
  assert.deepEqual(rules(validateIdentity('author', ' claude ', 'x@example.com')), ['ai-author']);
  assert.deepEqual(
    rules(validateIdentity('author', 'Claude Opus 5.5', 'x@example.com')),
    ['ai-author'],
  );
  assert.deepEqual(
    rules(validateIdentity('committer', 'Bot', 'devin-ai-integration[bot]@users.noreply.github.com')),
    ['ai-committer'],
  );
});

test('rejects AI Co-authored-by trailers by email or model name only', () => {
  const opus = 'feat: x\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>';
  assert.deepEqual(rules(validateMessage(opus)), ['ai-attribution']);
  const human = 'feat: x\n\nCo-authored-by: Codex Rivera <cr@example.com>';
  assert.deepEqual(validateMessage(human), []);
});

test('merge commits skip the header rule but not attribution or identity', () => {
  const header = 'Merge pull request #3 from x/y';
  assert.deepEqual(validateCommit({ ...human, parents: ['a', 'b'], message: header }), []);
  const trailer = validateCommit({
    ...human,
    parents: ['a', 'b'],
    message: `${header}\n\nCo-authored-by: Claude <noreply@anthropic.com>`,
  });
  assert.deepEqual(rules(trailer), ['ai-attribution']);
  const author = validateCommit({
    ...human,
    parents: ['a', 'b'],
    authorName: 'Claude',
    message: header,
  });
  assert.deepEqual(rules(author), ['ai-author']);
});

test('accepts git\'s default revert header when the wrapped header is valid', () => {
  assert.deepEqual(validateHeader('Revert "feat(cli): add doctor"'), []);
  assert.deepEqual(rules(validateHeader('Revert "update stuff"')), ['header']);
});
