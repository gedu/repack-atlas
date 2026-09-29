// Shared plumbing for the spawned-bin CLI tests (not a test file itself).
//
// These tests spawn the BUILT bin (`dist/cli.js`) — the real process, the
// real argv path, the real exit code. `package.json` wires a `pretest` build
// so `pnpm test` always runs against a fresh `dist/`; when the build is
// missing (someone invoked the test runner directly), `ensureBin()` fails
// with an actionable message instead of a confusing ENOENT.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

export const binPath = path.join(repoRoot, 'dist', 'cli.js');
export const fixturesDir = path.join(repoRoot, 'fixtures');

export interface BinResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn `node dist/cli.js ...args`; never throws on non-zero exit. */
export async function runBin(
  ...args: string[]
): Promise<BinResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [binPath, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    assert.equal(
      typeof failure.code,
      'number',
      `bin crashed rather than exited with a code: ${String(error)}`
    );
    const code = failure.code as number;
    return {
      code,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** Assert the built bin exists before spawning it. */
export async function ensureBin(): Promise<void> {
  const info = await stat(binPath).catch(() => null);
  assert.ok(
    info !== null,
    `${binPath} is missing — run \`pnpm build\` first (pnpm test does this via pretest)`
  );
}

/** Parse a `--json` payload, failing with the raw output when unparseable. */
export function parseJson<T = Record<string, unknown>>(raw: string): T {
  assert.doesNotThrow(
    () => JSON.parse(raw),
    `expected JSON on stdout, got:\n${raw}`
  );
  return JSON.parse(raw) as T;
}

/** Recursive copy for fixture trees (small, no symlinks, few files). */
export async function copyTree(
  source: string,
  destination: string
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else await copyFile(from, to);
  }
}
