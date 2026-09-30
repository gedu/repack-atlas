// Normalizes the `shared` option of `IntrospectionPlugin` to the facts-file
// array shape, so users can hand the same object they give Module Federation.
//
// Supported input (Module Federation `shared`):
//   - the Atlas array of `{ name, version?, singleton?, eager?, requiredVersion? }`
//   - an MF array whose items are package names (`'react'`) or MF maps
//   - an MF map `{ [pkg]: string | { singleton?, eager?, requiredVersion?,
//     version?, packageName?, ... } }`; a string value is the requiredVersion
// A map value of `true` or `false` means "no options" (the entry is kept with
// its name only). A package listed twice, in any combination of forms, throws.
// Unknown MF keys (`import`, `shareKey`, `shareScope`, `strictVersion`, ...)
// are ignored; `requiredVersion: false` and other non-string values are dropped.
// An object item with a string `name` is read as an Atlas entry, so an MF map
// for a package literally called "name" must go through the map form.
//
// A missing `version` is resolved from the installed package, never thrown on.
// That value is a heuristic (the bundler may resolve a different copy), so the
// entry is marked `versionConfidence: 'heuristic'`; declared versions are
// static and carry no marker.
//
// Atlas-owned code (NOT vendored).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IntrospectionSharedEntry } from '../core/introspection-types.js';

type MfSharedValue = string | boolean | Record<string, unknown>;

/** Accepted `shared` option: Atlas array, MF array, or MF map. */
export type IntrospectionSharedInput =
  | IntrospectionSharedEntry[]
  | Array<string | IntrospectionSharedEntry | Record<string, MfSharedValue>>
  | Record<string, MfSharedValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromMapEntry(
  pkg: string,
  value: unknown
): { entry: IntrospectionSharedEntry; packageName: string } {
  if (typeof value === 'string') {
    return { entry: { name: pkg, requiredVersion: value }, packageName: pkg };
  }
  if (value === true || value === undefined || value === false) {
    return { entry: { name: pkg }, packageName: pkg };
  }
  if (!isRecord(value)) {
    throw new Error(
      `shared["${pkg}"] must be a version string or an object, got ${typeof value}`
    );
  }
  const entry: IntrospectionSharedEntry = { name: pkg };
  if (typeof value.version === 'string') entry.version = value.version;
  if (typeof value.singleton === 'boolean') entry.singleton = value.singleton;
  if (typeof value.eager === 'boolean') entry.eager = value.eager;
  if (typeof value.requiredVersion === 'string') {
    entry.requiredVersion = value.requiredVersion;
  }
  const packageName =
    typeof value.packageName === 'string' && value.packageName !== ''
      ? value.packageName
      : pkg;
  return { entry, packageName };
}

/** Installed version of `pkg` as seen from `root`; `undefined` on any failure. */
export function resolveInstalledVersion(
  pkg: string,
  root: string
): string | undefined {
  try {
    const require = createRequire(path.join(root, 'package.json'));
    let manifestPath: string | undefined;
    try {
      manifestPath = require.resolve(`${pkg}/package.json`);
    } catch {
      // `exports` may hide package.json: resolve the entry, walk up to it.
      let dir = path.dirname(require.resolve(pkg));
      for (let depth = 0; depth < 8; depth += 1) {
        const candidate = path.join(dir, 'package.json');
        try {
          const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as {
            name?: unknown;
          };
          if (parsed.name === pkg) {
            manifestPath = candidate;
            break;
          }
        } catch {
          // no package.json at this level
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    if (!manifestPath) return undefined;
    const version = (
      JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: unknown }
    ).version;
    return typeof version === 'string' && version !== '' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn any accepted `shared` input into the facts-file array. Entries without
 * a `version` get one resolved from the installed package when `resolveFrom`
 * is known; when it cannot be resolved the version stays absent.
 */
export function normalizeShared(
  shared: IntrospectionSharedInput | undefined,
  resolveFrom?: string
): IntrospectionSharedEntry[] {
  if (shared === undefined) return [];
  const pending: Array<{ entry: IntrospectionSharedEntry; packageName: string }> =
    [];

  const addMap = (map: Record<string, unknown>): void => {
    for (const [pkg, value] of Object.entries(map)) {
      pending.push(fromMapEntry(pkg, value));
    }
  };

  if (Array.isArray(shared)) {
    (shared as unknown[]).forEach((item, index) => {
      if (typeof item === 'string') {
        pending.push(fromMapEntry(item, undefined));
      } else if (isRecord(item) && typeof item.name === 'string') {
        // Pick schema keys only: `versionConfidence` is set by the plugin,
        // never accepted from the caller.
        pending.push(fromMapEntry(item.name, item));
      } else if (isRecord(item)) {
        addMap(item);
      } else {
        throw new Error(
          `shared[${index}] must be a package name or an object, got ${typeof item}`
        );
      }
    });
  } else if (isRecord(shared)) {
    addMap(shared);
  } else {
    throw new Error('shared must be an array or a Module Federation map');
  }

  const seen = new Set<string>();
  for (const { entry } of pending) {
    if (seen.has(entry.name)) {
      throw new Error(
        `shared declares "${entry.name}" more than once; list each package once`
      );
    }
    seen.add(entry.name);
  }

  return pending.map(({ entry, packageName }) => {
    if (entry.version !== undefined || !resolveFrom) return entry;
    const version = resolveInstalledVersion(packageName, resolveFrom);
    return version === undefined
      ? entry
      : { ...entry, version, versionConfidence: 'heuristic' as const };
  });
}
