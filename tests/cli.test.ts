import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('cli prints its version', async () => {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', cliPath]);
  assert.match(stdout, /^repack-atlas \d+\.\d+\.\d+\n$/u);
});
