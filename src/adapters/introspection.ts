// `ConfigIntrospector` adapter (docs/PRD.md §16 item 3, T0 decision): Atlas
// never loads user rspack configs in-process. Apps opt in by adding the
// `repack-atlas/introspection` plugin to their rspack config, which writes
// `<appRoot>/.repack-atlas/introspection.json` declaring the federation
// facts Atlas needs before a build. This file reads and validates it through
// the `ProjectFs` port; the shape + validator are core-owned
// (`src/core/introspection-types.ts`).
//
// User-facing config snippet (document in README at T11):
//
//   // rspack.config.mts (host) — mini-apps analogous
//   import { IntrospectionPlugin } from 'repack-atlas/introspection';
//
//   export default {
//     plugins: [
//       new IntrospectionPlugin({
//         name: 'HostApp',
//         role: 'host',
//         exposes: [],
//         remotes: { MiniApp: 'http://127.0.0.1:8082' },
//         shared: [{ name: 'react', singleton: true, version: '19.0.0' }],
//         port: 8081,
//         native: { reactNativeVersion: '0.81.0', newArch: true },
//       }),
//     ],
//   };

import path from 'node:path';
import {
  INTROSPECTION_RELATIVE_PATH,
  toIntrospectionFacts,
  validateIntrospectionFacts,
  type ConfigIntrospector,
  type IntrospectionResult,
  type ProjectFs,
} from '../core/index.js';

/** Path of the facts document for an app root. */
export function introspectionFactsPath(appRoot: string): string {
  return path.join(appRoot, ...INTROSPECTION_RELATIVE_PATH);
}

/**
 * Read `.repack-atlas/introspection.json` from an app root. Never throws:
 * absent file → `missing`, malformed document → `invalid` with reasons
 * (never guessed around), valid document → typed facts.
 */
export function createConfigIntrospector(fs: ProjectFs): ConfigIntrospector {
  return {
    async read(appRoot: string): Promise<IntrospectionResult> {
      const filePath = introspectionFactsPath(appRoot);
      const exists = await fs.exists(filePath);
      if (!exists) {
        return {
          status: 'failed',
          failure: 'missing',
          message:
            `No introspection file at ${filePath}. Add the ` +
            `'repack-atlas/introspection' plugin to this app's rspack ` +
            `config to declare its federation facts.`,
        };
      }
      const rawText = await fs.readFile(filePath);
      if (rawText === null) {
        return {
          status: 'failed',
          failure: 'invalid',
          message: `Introspection file at ${filePath} exists but could not be read.`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch (error) {
        return {
          status: 'failed',
          failure: 'invalid',
          message: `Introspection file at ${filePath} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const reasons = validateIntrospectionFacts(parsed);
      if (reasons.length > 0) {
        return {
          status: 'failed',
          failure: 'invalid',
          message: `Introspection file at ${filePath}: ${reasons.join('; ')}`,
        };
      }
      return {
        status: 'ok',
        facts: toIntrospectionFacts(parsed as Record<string, unknown>),
        resolvedFrom: filePath,
      };
    },
  };
}
