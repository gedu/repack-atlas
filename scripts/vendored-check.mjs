#!/usr/bin/env node
/**
 * vendored-check — CI guard for the `vendored-provenance` rule (PRD §12,
 * AGENTS.md rule 1).
 *
 * Every file under `src/repack-bridge/vendored/**` must:
 *   1. appear in VENDORED.md as a `## \`<repo-relative path>\`` section, and
 *   2. that section must carry a `**Commit**: \`<sha>\`` line, and
 *   3. the file itself must start with a Copyright license header.
 *
 * On drift: prints the offending paths (one per line, prefixed with the
 * reason) and exits 1. Zero dependencies, macOS/Linux, works from any cwd.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED_DIR = join(REPO_ROOT, 'src', 'repack-bridge', 'vendored');
const VENDORED_MD = join(REPO_ROOT, 'VENDORED.md');

/** @returns {string[]} repo-relative posix paths of every vendored file */
function listVendoredFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listVendoredFiles(full));
    } else {
      out.push(relative(REPO_ROOT, full).split(/[\\/]/).join('/'));
    }
  }
  return out.sort();
}

/**
 * Split VENDORED.md into per-path sections:
 * `## \`<path>\`` headings map to their body up to the next `## ` heading.
 * @param {string} md
 */
function parseLedger(md) {
  /** @type {Map<string, string>} */
  const sections = new Map();
  const headingRe = /^## `([^`]+)`\s*$/;
  let currentPath = null;
  let body = [];
  for (const line of md.split(/\r?\n/)) {
    const match = line.match(headingRe);
    if (match) {
      if (currentPath !== null) sections.set(currentPath, body.join('\n'));
      currentPath = match[1];
      body = [];
    } else if (currentPath !== null) {
      if (/^## /.test(line)) {
        sections.set(currentPath, body.join('\n'));
        currentPath = null;
      } else {
        body.push(line);
      }
    }
  }
  if (currentPath !== null) sections.set(currentPath, body.join('\n'));
  return sections;
}

if (!existsSync(VENDORED_DIR)) {
  console.error(`vendored-check: ${relative(REPO_ROOT, VENDORED_DIR)} not found`);
  process.exit(1);
}
if (!existsSync(VENDORED_MD)) {
  console.error('vendored-check: VENDORED.md not found');
  process.exit(1);
}

const files = listVendoredFiles(VENDORED_DIR);
const ledger = parseLedger(readFileSync(VENDORED_MD, 'utf8'));
const commitRe = /\*\*Commit\*\*:\s*`([0-9a-f]{7,40})`/;

/** @type {string[]} */
const problems = [];

for (const file of files) {
  const section = ledger.get(file);
  if (section === undefined) {
    problems.push(`missing from VENDORED.md: ${file}`);
  } else if (!commitRe.test(section)) {
    problems.push(`missing **Commit**: \`<sha>\` in its VENDORED.md section: ${file}`);
  }

  const content = readFileSync(join(REPO_ROOT, file), 'utf8');
  // License headers live at the top of the file; check the first 15 lines.
  const head = content.split(/\r?\n/, 15).join('\n');
  if (!/Copyright/i.test(head)) {
    problems.push(`missing Copyright header in the first 15 lines: ${file}`);
  }
}

if (problems.length > 0) {
  console.error(`vendored-check: ${problems.length} provenance problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Fix VENDORED.md or the file headers (skill: atlas-bridge-vendoring).');
  process.exit(1);
}

console.log(`vendored-check: OK - ${files.length} vendored file(s) accounted for in VENDORED.md`);
