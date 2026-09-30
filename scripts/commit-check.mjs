#!/usr/bin/env node
/**
 * commit-check — CI guard for AGENTS.md rule 8 (Conventional Commits, no AI
 * attribution).
 *
 * Usage:
 *   node scripts/commit-check.mjs [--range <base>..<head>] [--message <text>]
 *
 * With no arguments it checks `origin/main..HEAD`. `--message` validates a
 * single header (used for the PR title) and skips the commit walk unless
 * `--range` is also given.
 *
 * Per commit it checks: Conventional Commit header (<= 100 chars), no
 * fixup!/squash! leftovers, no AI attribution trailers or "Generated with"
 * lines in the body, and no AI identity as author or committer. Merge commits
 * skip only the header rule.
 *
 * Output: one `<short-sha> <rule>: <detail>` line per violation.
 * Exit codes: 0 clean, 1 violations found, 2 usage or git error.
 * Zero dependencies; the pure logic is exported so tests can import it.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Single source of truth for the allowed commit/PR-title types. */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'test',
  'chore',
  'refactor',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
];

export const MAX_HEADER_LENGTH = 100;

const HEADER_RE = new RegExp(
  `^(${COMMIT_TYPES.join('|')})(\\([a-z0-9./-]+\\))?!?: \\S.*`,
);

/**
 * AI identity rules. This block is the one place to tune what counts as an AI
 * tool. Matching is deliberately NOT a substring test on names, so a human
 * called "Claude Martin" or with "codex" in their name passes.
 */

/** Names that, taken exactly (case-insensitive, trimmed), are an AI tool. */
export const AI_TOOL_NAMES = [
  'claude',
  'claude code',
  'copilot',
  'github copilot',
  'chatgpt',
  'codex',
  'openai codex',
  'gemini',
  'gemini code assist',
  'cursor',
  'cursor agent',
  'devin',
  'aider',
  'opencode',
  'cline',
  'jules',
];

/** Model-style names: "Claude Opus 5.5", "Claude 3.5 Sonnet", "GPT-4o". */
const AI_MODEL_NAME_RES = [
  /^claude\s+(opus|sonnet|haiku|fable|code|v?\d)/i,
  /\bgpt-\S+/i,
];

/** Email addresses that belong to an AI tool or its GitHub bot account. */
const AI_EMAIL_RES = [
  /^noreply@(anthropic|openai)\.com$/i,
  /^cursoragent@cursor\.com$/i,
  /@aider\.chat$/i,
  // GitHub noreply, with an optional "<id>+" prefix and optional "[bot]".
  /^(\d+\+)?(copilot[^@]*|claude|devin-ai-integration|google-labs-jules|chatgpt-codex-connector)(\[bot\])?@users\.noreply\.github\.com$/i,
  /^(\d+\+)?cursor[^@]*\[bot\]@users\.noreply\.github\.com$/i,
];

/**
 * @param {string} name
 * @param {string} email
 * @returns {boolean} true when the name/email pair is an AI tool identity
 */
export function isAiIdentity(name, email) {
  const trimmed = name.trim();
  return (
    AI_EMAIL_RES.some((re) => re.test(email.trim())) ||
    AI_TOOL_NAMES.includes(trimmed.toLowerCase()) ||
    AI_MODEL_NAME_RES.some((re) => re.test(trimmed))
  );
}

/**
 * Split a trailer value "Name <email>" (email optional).
 * @param {string} value
 */
function parseTrailerIdentity(value) {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(value.trim());
  return m ? { name: m[1] ?? '', email: m[2] ?? '' } : { name: value.trim(), email: '' };
}

/** Loose text match, used only for free-text "Generated with ..." lines. */
const AI_TEXT_RE =
  /claude|anthropic|openai|chatgpt|gpt-|copilot|gemini|codex|opencode|windsurf|codeium|\bcursor\b|\bdevin\b|\baider\b|\bcline\b/i;

const ATTRIBUTION_TRAILER_RE =
  /^(co-authored-by|reviewed-by|tested-by|signed-off-by|assisted-by|generated-by):\s*(.*)$/i;

/** Trailers whose value names the tool itself, not a person. */
const TOOL_TRAILERS = new Set(['assisted-by', 'generated-by']);

/**
 * @param {string} key lower-case trailer key
 * @param {string} value
 */
function isAiTrailer(key, value) {
  const { name, email } = parseTrailerIdentity(value);
  if (isAiIdentity(name, email)) return true;
  // "Assisted-by: ChatGPT gpt-4o": any word that is a tool name counts.
  return (
    TOOL_TRAILERS.has(key) &&
    name
      .toLowerCase()
      .split(/\s+/)
      .some((word) => AI_TOOL_NAMES.includes(word))
  );
}

/** @typedef {{ rule: string, detail: string }} Violation */

/**
 * @param {string} header first line of a commit message or a PR title
 * @returns {Violation[]}
 */
export function validateHeader(header) {
  /** @type {Violation[]} */
  const out = [];
  if (/^(fixup|squash)!/.test(header)) {
    out.push({
      rule: 'fixup',
      detail: `"${header}" must be squashed before merge`,
    });
    return out;
  }
  // git's default revert header wraps the original one: Revert "feat: x".
  const revert = /^Revert "(.+)"$/.exec(header);
  const subject = revert ? revert[1] : header;
  if (!HEADER_RE.test(subject)) {
    out.push({
      rule: 'header',
      detail: `"${header}" is not "<${COMMIT_TYPES.join('|')}>(scope)?: summary"`,
    });
  }
  if (header.length > MAX_HEADER_LENGTH) {
    out.push({
      rule: 'header-length',
      detail: `${header.length} chars, maximum is ${MAX_HEADER_LENGTH}`,
    });
  }
  return out;
}

/**
 * Header plus body rules for one full commit message.
 * @param {string} message
 * @param {{ skipHeader?: boolean }} [options] skip the header rule (merge commits)
 * @returns {Violation[]}
 */
export function validateMessage(message, { skipHeader = false } = {}) {
  const lines = message.split(/\r?\n/);
  /** @type {Violation[]} */
  const out = skipHeader ? [] : validateHeader(lines[0] ?? '');
  for (const line of lines.slice(1)) {
    const trailer = ATTRIBUTION_TRAILER_RE.exec(line.trim());
    if (trailer && isAiTrailer((trailer[1] ?? '').toLowerCase(), trailer[2] ?? '')) {
      out.push({ rule: 'ai-attribution', detail: `trailer "${line.trim()}"` });
      continue;
    }
    const text = line.trim();
    const robotBanner = /^🤖\s*generated\b/i.test(text);
    const generatedBy =
      /\b(generated|written|authored|created|assisted) (with|by)\b/i.test(text) &&
      AI_TEXT_RE.test(text);
    if (robotBanner || generatedBy) {
      out.push({ rule: 'ai-attribution', detail: `line "${text}"` });
    }
  }
  return out;
}

/**
 * @param {'author' | 'committer'} role
 * @param {string} name
 * @param {string} email
 * @returns {Violation[]}
 */
export function validateIdentity(role, name, email) {
  // GitHub's web-merge committer is not an AI tool.
  if (role === 'committer' && email.toLowerCase() === 'noreply@github.com') {
    return [];
  }
  if (isAiIdentity(name, email)) {
    return [{ rule: `ai-${role}`, detail: `${name} <${email}>` }];
  }
  return [];
}

/**
 * Validate one parsed commit. Merge commits (more than one parent) skip only
 * the header rule; attribution and identity checks still apply.
 * @param {{ parents: string[], authorName: string, authorEmail: string,
 *   committerName: string, committerEmail: string, message: string }} commit
 * @returns {Violation[]}
 */
export function validateCommit(commit) {
  const isMerge = commit.parents.length > 1;
  return [
    ...validateMessage(commit.message, { skipHeader: isMerge }),
    ...validateIdentity('author', commit.authorName, commit.authorEmail),
    ...validateIdentity('committer', commit.committerName, commit.committerEmail),
  ];
}

/**
 * @param {string} range
 * @returns {Array<Parameters<typeof validateCommit>[0] & { sha: string }>}
 */
function readCommits(range) {
  const out = execFileSync(
    'git',
    ['log', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e', range],
    { encoding: 'utf8' },
  );
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha = '', parents = '', an = '', ae = '', cn = '', ce = '', ...rest] =
        record.split('\x1f');
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        authorName: an,
        authorEmail: ae,
        committerName: cn,
        committerEmail: ce,
        message: rest.join('\x1f').trim(),
      };
    });
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ range?: string, message?: string }} */
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--range' && flag !== '--message') || value === undefined) {
      throw new Error(`unexpected argument: ${flag ?? ''}`);
    }
    args[flag === '--range' ? 'range' : 'message'] = value;
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`commit-check: ${error.message}`);
    console.error('usage: commit-check.mjs [--range <base>..<head>] [--message <text>]');
    return 2;
  }

  /** @type {string[]} */
  const lines = [];
  let checked = 0;

  if (args.message !== undefined) {
    checked += 1;
    for (const v of validateHeader(args.message.split(/\r?\n/)[0] ?? '')) {
      lines.push(`message ${v.rule}: ${v.detail}`);
    }
  }

  if (args.range !== undefined || args.message === undefined) {
    let commits;
    try {
      commits = readCommits(args.range ?? 'origin/main..HEAD');
    } catch (error) {
      console.error(`commit-check: git log failed: ${error.message}`);
      return 2;
    }
    for (const commit of commits) {
      checked += 1;
      for (const v of validateCommit(commit)) {
        lines.push(`${commit.sha.slice(0, 7)} ${v.rule}: ${v.detail}`);
      }
    }
  }

  if (lines.length > 0) {
    for (const line of lines) console.log(line);
    console.error(
      `commit-check: ${lines.length} violation(s). Fix the commit messages (see CONTRIBUTING.md).`,
    );
    return 1;
  }
  console.log(`commit-check: OK - ${checked} item(s) checked`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
