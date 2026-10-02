// Single source of the CLI version string (G4): `src/cli.ts` reads it for
// `--version` and `src/cli/dev.ts` reads it for the startup banner. The
// version lives in the package root, hence `../package.json` relative to
// this file in `src/cli/` — the same URL cli.ts used before the extraction.

import { readFile } from 'node:fs/promises';

const packageJsonUrl = new URL('../../package.json', import.meta.url);

export async function readVersion(): Promise<string> {
  const { version } = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
    version: string;
  };
  return version;
}
