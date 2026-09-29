#!/usr/bin/env node
// TODO(T7): replace this placeholder with the real `repack-atlas` command
// surface (`doctor`, `inspect`, `init`, `dev`) including --json and exit codes.
import { readFile } from 'node:fs/promises';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const { version } = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
  version: string;
};

process.stdout.write(`repack-atlas ${version}\n`);
