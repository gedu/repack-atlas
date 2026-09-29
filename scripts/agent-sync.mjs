#!/usr/bin/env node
/**
 * agent-sync — keeps the multi-agent surface of this repo consistent.
 *
 * Canonical source: `.agents/skills/<name>/SKILL.md` (agentskills.io format).
 * From it this script derives:
 *   1. `.claude/skills/<name>` relative symlinks (Claude Code does not read
 *      `.agents/skills` on its own; Codex/Cursor/VS Code/OpenCode do).
 *   2. The skills table and the auto-invoke table in `AGENTS.md`, regenerated
 *      between their marker comments.
 *
 * Usage:
 *   node scripts/agent-sync.mjs            repair
 *   node scripts/agent-sync.mjs --check    CI: exit 1 and report drift
 *
 * Zero dependencies, macOS/Linux. Works from any cwd: the repo root is derived
 * from this file's URL, never from process.cwd().
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_SOURCE_DIR = join(REPO_ROOT, '.agents', 'skills');
const CLAUDE_SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');
const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_MAX = 1024;

const TABLE_BEGIN = '<!-- BEGIN auto-generated skills table -->';
const TABLE_END = '<!-- END auto-generated skills table -->';
const INVOKE_BEGIN = '<!-- BEGIN auto-generated auto-invoke table -->';
const INVOKE_END = '<!-- END auto-generated auto-invoke table -->';

const checkOnly = process.argv.includes('--check');
/** @type {string[]} */
const problems = [];

/**
 * Minimal frontmatter reader: enough for `name`, `description` and
 * `metadata.auto_invoke`, including block scalars (`>-`, `|`) and multi-line
 * YAML lists. Deliberately not a general YAML parser.
 * @param {string} text
 */
function parseSkillFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { error: 'SKILL.md must start with a `---` frontmatter delimiter' };
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) {
    return { error: 'unterminated frontmatter block (missing closing `---`)' };
  }
  const body = lines.slice(1, end);

  let name;
  /** @type {string | undefined} */
  let description;
  /** @type {string[]} */
  const autoInvoke = [];

  /** @typedef {{ key: string, style: string, indent: number }} Block */
  /** @type {Block | undefined} */
  let block;
  const indentOf = (line) => line.match(/^\s*/)[0].length;

  for (const line of body) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);

    // List item inside the current block scalar/list.
    if (block && indent > block.indent && line.trim().startsWith('- ')) {
      if (block.key === 'auto_invoke') {
        autoInvoke.push(stripScalar(itemText(line)));
      }
      continue;
    }

    // Continuation line of a folded/literal `description` scalar.
    if (
      block &&
      block.key === 'description' &&
      indent > block.indent &&
      block.style !== ''
    ) {
      description = (description ? `${description} ` : '') + line.trim();
      continue;
    }

    const kv = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;

    block = undefined;

    if (key === 'auto_invoke') {
      if (rawValue.trim()) {
        // Inline flow list: `auto_invoke: [a, b]`
        for (const item of parseFlowList(rawValue)) autoInvoke.push(item);
        block = { key: 'auto_invoke', style: '', indent };
      } else {
        block = { key: 'auto_invoke', style: 'list', indent };
      }
      continue;
    }

    if (key === 'name') {
      name = stripScalar(rawValue);
      continue;
    }

    if (key === 'description') {
      const style = /^[|>][-+]?$/.test(rawValue.trim()) ? rawValue.trim() : '';
      description = style ? '' : stripScalar(rawValue);
      block = { key: 'description', style, indent };
      continue;
    }
  }

  return { name, description, autoInvoke };
}

/** @param {string} line */
function itemText(line) {
  return line.trim().replace(/^-\s+/, '');
}

/** @param {string} raw */
function parseFlowList(raw) {
  return raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => stripScalar(item))
    .filter(Boolean);
}

/** @param {string | undefined} value */
function stripScalar(value) {
  if (value === undefined) return undefined;
  let out = value.trim();
  const quote = out[0];
  if ((quote === '"' || quote === "'") && out.endsWith(quote)) {
    out = out.slice(1, -1);
  }
  return out;
}

/** @param {string} dir */
function listSkillDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => {
      try {
        return statSync(join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * @param {string} dirName
 * @param {string} skillPath
 */
function loadSkill(dirName, skillPath) {
  const text = readFileSync(skillPath, 'utf8');
  const parsed = parseSkillFrontmatter(text);
  if (parsed.error) {
    problems.push(`${skillPath}: ${parsed.error}`);
    return undefined;
  }

  const rel = relative(REPO_ROOT, skillPath);
  const { name, description, autoInvoke = [] } = parsed;

  if (!name) {
    problems.push(`${rel}: frontmatter is missing \`name\``);
  } else if (name !== dirName) {
    problems.push(`${rel}: name "${name}" does not match directory "${dirName}"`);
  } else if (!SKILL_NAME_RE.test(name)) {
    problems.push(`${rel}: name "${name}" violates ^[a-z0-9]+(-[a-z0-9]+)*$`);
  }

  if (!description) {
    problems.push(`${rel}: frontmatter is missing \`description\``);
  } else if (description.length > DESCRIPTION_MAX) {
    problems.push(
      `${rel}: description is ${description.length} chars, limit is ${DESCRIPTION_MAX}`,
    );
  }

  if (name && description) {
    return { name, description, autoInvoke, path: rel };
  }
  return undefined;
}

/** Repair or verify one `.claude/skills/<name>` symlink. */
function syncClaudeLink(name) {
  const target = join(SKILLS_SOURCE_DIR, name);
  const linkPath = join(CLAUDE_SKILLS_DIR, name);
  const expectedTarget = relative(CLAUDE_SKILLS_DIR, target);

  let current;
  try {
    current = lstatSync(linkPath);
  } catch {
    current = undefined;
  }

  let issue;
  if (!current) {
    issue = 'missing';
  } else if (!current.isSymbolicLink()) {
    issue = 'present but not a symlink';
  } else {
    const raw = readlinkSync(linkPath);
    const resolved = resolve(dirname(linkPath), raw);
    const ok = existsSync(resolved) && realpathSync(resolved) === realpathSync(target);
    if (!ok) issue = `symlink points at ${raw}, expected ${expectedTarget}`;
  }

  if (!issue) return;

  if (checkOnly) {
    problems.push(
      `.claude/skills/${name}: ${issue} — run \`pnpm agent:sync\` to repair`,
    );
    return;
  }

  if (current && current.isDirectory() && !current.isSymbolicLink()) {
    problems.push(
      `.claude/skills/${name}: is a real directory, refusing to overwrite it`,
    );
    return;
  }

  mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
  if (current) rmSync(linkPath, { force: true });
  symlinkSync(expectedTarget, linkPath, 'dir');
  console.log(`.claude/skills/${name} -> ${expectedTarget}`);
}

/** Replace the text between two markers (markers kept). */
function replaceBetween(content, begin, end, replacement) {
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    problems.push(`AGENTS.md: markers not found for "${begin}"`);
    return content;
  }
  const before = content.slice(0, start + begin.length);
  const after = content.slice(stop);
  return `${before}\n\n${replacement}\n\n${after}`;
}

/** @param {{ name: string, path: string }[]} skills */
function renderTable(skills) {
  const rows = skills.map(
    (skill) => `| \`${skill.name}\` | ${firstSentence(skill.description)} | \`${skill.path}\` |`,
  );
  return ['| Skill | Trigger | Path |', '|---|---|---|', ...rows].join('\n');
}

/** @param {{ name: string, autoInvoke: string[] }[]} skills */
function renderAutoInvoke(skills) {
  const rows = [];
  for (const skill of skills) {
    for (const action of skill.autoInvoke) {
      rows.push(`| ${action} | \`${skill.name}\` |`);
    }
  }
  if (rows.length === 0) return '_No auto-invoke rules declared._';
  return [
    'When performing the action on the left, ALWAYS load the skill on the right',
    'before writing code.',
    '',
    '| When performing | ALWAYS load first |',
    '|---|---|',
    ...rows,
  ].join('\n');
}

/** First sentence of a description, used as the trigger column. */
function firstSentence(description) {
  const match = description.match(/Trigger:.*$/i);
  const text = match ? match[0] : description;
  return text.replace(/\s+/g, ' ').trim();
}

function main() {
  const dirs = listSkillDirs(SKILLS_SOURCE_DIR);
  if (dirs.length === 0) {
    problems.push(`no skills found under ${relative(REPO_ROOT, SKILLS_SOURCE_DIR)}`);
  }

  /** @type {{ name: string, description: string, autoInvoke: string[], path: string }[]} */
  const skills = [];
  for (const dir of dirs) {
    const skillPath = join(SKILLS_SOURCE_DIR, dir, 'SKILL.md');
    if (!existsSync(skillPath)) {
      problems.push(`.agents/skills/${dir}: missing SKILL.md`);
      continue;
    }
    const skill = loadSkill(dir, skillPath);
    if (skill) skills.push(skill);
    syncClaudeLink(dir);
  }

  if (problems.length === 0) {
    const original = readFileSync(AGENTS_MD, 'utf8');
    const updated = replaceBetween(
      replaceBetween(original, TABLE_BEGIN, TABLE_END, renderTable(skills)),
      INVOKE_BEGIN,
      INVOKE_END,
      renderAutoInvoke(skills),
    );
    if (updated !== original) {
      if (checkOnly) {
        problems.push(
          'AGENTS.md: generated tables are out of sync with SKILL.md frontmatter — run `pnpm agent:sync`',
        );
      } else {
        writeFileSync(AGENTS_MD, updated);
        console.log('AGENTS.md: regenerated skills + auto-invoke tables');
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      `${checkOnly ? 'agent-sync --check FAILED' : 'agent-sync FAILED'} with ${problems.length} problem(s):`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `${checkOnly ? 'agent-sync --check OK' : 'agent-sync done'}: ${skills.length} skill${
      skills.length === 1 ? '' : 's'
    } in sync (${relative(REPO_ROOT, CLAUDE_SKILLS_DIR)}/ symlinks + AGENTS.md tables).`,
  );
}

main();
