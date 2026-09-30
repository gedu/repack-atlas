// Node adapter for the `ReactNativeCliResolver` port. The CLI is resolved
// from the APP's own root with `createRequire` (AGENTS.md rule 4: user
// project resolution, never Atlas's own tree), following Node's upward
// `node_modules` walk and pnpm symlinks. PATH is never consulted and no other
// app's install can stand in. Mirrors upstream callstack/repack PR #1467
// `rnBin.ts` (`resolveReactNativeBin`): resolve `react-native/package.json`,
// then read `bin.react-native`; the script is run as `node <cli> start ...`
// because the `.bin` shim breaks under some pnpm layouts.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  ReactNativeCliResolver,
  ReactNativeCliResult,
} from '../core/ports.js';

export function createReactNativeCliResolver(): ReactNativeCliResolver {
  return {
    resolve(appRoot: string): ReactNativeCliResult {
      let packageJsonPath: string;
      try {
        packageJsonPath = createRequire(
          path.join(appRoot, 'package.json')
        ).resolve('react-native/package.json');
      } catch {
        return {
          status: 'failed',
          message:
            `cannot resolve the "react-native" package from ${appRoot} — ` +
            'each app runs with its own local react-native CLI; install it in the app',
        };
      }

      const packageDir = path.dirname(packageJsonPath);
      let bin: unknown;
      try {
        const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
          bin?: unknown;
        };
        bin =
          typeof manifest.bin === 'string'
            ? manifest.bin
            : (manifest.bin as Record<string, unknown> | undefined)?.[
                'react-native'
              ];
      } catch {
        bin = undefined;
      }
      if (typeof bin !== 'string' || bin === '') {
        return {
          status: 'failed',
          message:
            `the react-native package at ${packageDir} declares no ` +
            '"bin.react-native" script — it cannot be used to start an app',
        };
      }
      return { status: 'ok', cli: path.resolve(packageDir, bin) };
    },
  };
}
