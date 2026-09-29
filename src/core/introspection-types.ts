// Core-owned schema for the per-app introspection facts file
// (`.repack-atlas/introspection.json`) — docs/PRD.md §16 item 3 (T0
// decision): Atlas does not load user rspack configs in-process; users add
// the opt-in `repack-atlas/introspection` plugin, which declares federation
// facts into this file. Core owns the shape and the validator; the plugin
// (bridge) writes it and the adapter (`src/adapters/introspection.ts`)
// reads/validates it.
//
// The shape deliberately mirrors what the federation manifest already
// declares (`name`, `exposes`, `remotes`, `shared`) plus the two facts the
// manifest cannot know before a build: the dev-server `port` and a coarse
// `native` scope, so doctor/graph can work before the first build.

/** Filename of the facts document inside the app root. */
export const INTROSPECTION_RELATIVE_PATH = [
  '.repack-atlas',
  'introspection.json',
] as const;

/** One `shared` declaration, mirroring the manifest entry shape. */
export interface IntrospectionSharedEntry {
  name: string;
  version?: string;
  singleton?: boolean;
  eager?: boolean;
  requiredVersion?: string;
}

/** Coarse native scope: what an app declares about its native surface. */
export interface IntrospectionNativeScope {
  /** React Native version the app builds against, if declared. */
  reactNativeVersion?: string;
  newArch?: boolean;
  platforms?: string[];
  /** Native module package names the app links. */
  nativeModules?: string[];
}

/** Typed shape of a valid `.repack-atlas/introspection.json`. */
export interface AppIntrospectionFacts {
  /** Schema version for forward compatibility; v1 today. */
  schemaVersion: 1;
  /** Federation container name of the app. */
  name: string;
  /** Expose keys (`./Screen` → ['./Screen']). */
  exposes: string[];
  /** Declared remotes: federation name → entry URL or local reference. */
  remotes: Record<string, string>;
  shared: IntrospectionSharedEntry[];
  /** Dev-server port, when the app declares one. */
  port?: number;
  native?: IntrospectionNativeScope;
  /** 'host' | 'remote' — informational, not load-bearing for rules. */
  role?: 'host' | 'remote';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Hand-written structural validation (no deps) of an unknown JSON document
 * against `AppIntrospectionFacts`. Returns the reasons the document is
 * invalid — empty when valid. Unlike the workspace config, unknown top-level
 * keys are tolerated (the plugin is ours, but forward-compatible readers are
 * the point of `schemaVersion`).
 */
export function validateIntrospectionFacts(document: unknown): string[] {
  if (!isObject(document)) return ['introspection document must be a JSON object'];

  const reasons: string[] = [];

  if (document.schemaVersion !== 1) {
    reasons.push('schemaVersion is required (number 1)');
  }
  if (typeof document.name !== 'string' || document.name === '') {
    reasons.push('name is required (non-empty string)');
  }
  if (!isStringArray(document.exposes)) {
    reasons.push('exposes is required (array of strings)');
  }
  if (
    !isObject(document.remotes) ||
    Object.values(document.remotes).some((v) => typeof v !== 'string')
  ) {
    reasons.push('remotes is required (object of string values)');
  }
  if (!Array.isArray(document.shared)) {
    reasons.push('shared is required (array)');
  } else {
    document.shared.forEach((entry, i) => {
      if (!isObject(entry) || typeof entry.name !== 'string') {
        reasons.push(`shared[${i}].name is required (string)`);
        return;
      }
      for (const key of ['version', 'requiredVersion'] as const) {
        const v = entry[key];
        if (v !== undefined && typeof v !== 'string') {
          reasons.push(`shared[${i}].${key} must be a string`);
        }
      }
      for (const key of ['singleton', 'eager'] as const) {
        const v = entry[key];
        if (v !== undefined && typeof v !== 'boolean') {
          reasons.push(`shared[${i}].${key} must be a boolean`);
        }
      }
    });
  }
  if (document.port !== undefined && typeof document.port !== 'number') {
    reasons.push('port must be a number');
  }
  if (document.role !== undefined && document.role !== 'host' && document.role !== 'remote') {
    reasons.push('role must be "host" or "remote"');
  }
  if (document.native !== undefined) {
    if (!isObject(document.native)) {
      reasons.push('native must be an object');
    } else {
      const native = document.native;
      if (native.reactNativeVersion !== undefined && typeof native.reactNativeVersion !== 'string') {
        reasons.push('native.reactNativeVersion must be a string');
      }
      if (native.newArch !== undefined && typeof native.newArch !== 'boolean') {
        reasons.push('native.newArch must be a boolean');
      }
      if (native.platforms !== undefined && !isStringArray(native.platforms)) {
        reasons.push('native.platforms must be an array of strings');
      }
      if (native.nativeModules !== undefined && !isStringArray(native.nativeModules)) {
        reasons.push('native.nativeModules must be an array of strings');
      }
    }
  }

  return reasons;
}

/**
 * Narrow a validated document to typed facts. Only call after
 * {@link validateIntrospectionFacts} returned no reasons; normalization is
 * limited to defaulting absent optional collections.
 */
export function toIntrospectionFacts(
  document: Record<string, unknown>
): AppIntrospectionFacts {
  const native = isObject(document.native) ? document.native : undefined;
  return {
    schemaVersion: 1,
    name: document.name as string,
    exposes: document.exposes as string[],
    remotes: document.remotes as Record<string, string>,
    shared: (document.shared as IntrospectionSharedEntry[]) ?? [],
    ...(typeof document.port === 'number' ? { port: document.port } : {}),
    ...(document.role === 'host' || document.role === 'remote'
      ? { role: document.role }
      : {}),
    ...(native
      ? {
          native: {
            ...(typeof native.reactNativeVersion === 'string'
              ? { reactNativeVersion: native.reactNativeVersion }
              : {}),
            ...(typeof native.newArch === 'boolean'
              ? { newArch: native.newArch }
              : {}),
            ...(isStringArray(native.platforms)
              ? { platforms: native.platforms }
              : {}),
            ...(isStringArray(native.nativeModules)
              ? { nativeModules: native.nativeModules }
              : {}),
          },
        }
      : {}),
  };
}
