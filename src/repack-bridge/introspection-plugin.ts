// `repack-atlas/introspection` subpath — the opt-in declaration plugin a
// user adds to each app's rspack config (docs/PRD.md §16 item 3, T0
// decision: no in-process loading of user configs for the demo).
//
// It is a marker, not an analyzer: it serializes the federation facts the
// USER already wrote in their config into
// `<appRoot>/.repack-atlas/introspection.json`, so Atlas can read them
// without ever evaluating the config. Facts are validated against the
// core-owned schema at construction time — a typo fails the user's build
// with the field path, instead of silently producing a bad facts file.
//
// Atlas-owned code (NOT vendored). User-facing snippet lives in the
// `createConfigIntrospector` doc comment (src/adapters/introspection.ts)
// and lands in the README at T11.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  normalizeShared,
  type IntrospectionSharedInput,
} from './shared-map.js';
import {
  INTROSPECTION_RELATIVE_PATH,
  validateIntrospectionFacts,
  type AppIntrospectionFacts,
  type IntrospectionNativeScope,
} from '../core/introspection-types.js';

/** What a user declares in their rspack config. */
export interface IntrospectionPluginOptions {
  /** Federation container name of the app. */
  name: string;
  role?: 'host' | 'remote';
  exposes?: string[];
  remotes?: Record<string, string>;
  /**
   * Either the facts array or the same Module Federation `shared` object
   * given to ModuleFederationPlugin (map, name array, string values). A
   * missing `version` is resolved from the installed package and marked
   * `versionConfidence: 'heuristic'`.
   */
  shared?: IntrospectionSharedInput;
  /** Dev-server port this app serves on. */
  port?: number;
  native?: IntrospectionNativeScope;
  /**
   * App root the facts file is written under. Defaults to the compiler's
   * context when available; pass explicitly for configs built without one.
   */
  appRoot?: string;
}

export class IntrospectionPlugin {
  constructor(private readonly options: IntrospectionPluginOptions) {}

  /** The exact document the plugin writes (also what tests assert). */
  buildDocument(compilerContext?: string): AppIntrospectionFacts {
    const {
      name,
      role,
      exposes = [],
      remotes = {},
      port,
      native,
    } = this.options;
    const shared = normalizeShared(
      this.options.shared,
      this.options.appRoot ?? compilerContext
    );
    const document: Record<string, unknown> = {
      schemaVersion: 1,
      name,
      exposes,
      remotes,
      shared,
    };
    if (port !== undefined) document.port = port;
    if (role !== undefined) document.role = role;
    if (native !== undefined) document.native = native;

    const reasons = validateIntrospectionFacts(document);
    if (reasons.length > 0) {
      throw new Error(
        `IntrospectionPlugin for "${name}": ${reasons.join('; ')}`
      );
    }
    return document as unknown as AppIntrospectionFacts;
  }

  /**
   * rspack plugin entry. Writes synchronously at apply time (config
   * evaluation): the facts are static user declarations, so no compilation
   * state is needed, and configs that never compile still leave a readable
   * declaration behind.
   */
  apply(compiler: unknown): void {
    const context = (compiler as { context?: string } | undefined)?.context;
    const document = this.buildDocument(context);
    const appRoot = this.options.appRoot ?? context;
    if (!appRoot) {
      throw new Error(
        `IntrospectionPlugin for "${this.options.name}": no app root — the ` +
          'compiler exposes no `context` and no `appRoot` option was given.'
      );
    }
    const filePath = path.join(appRoot, ...INTROSPECTION_RELATIVE_PATH);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(document, null, 2) + '\n', 'utf-8');
  }
}
