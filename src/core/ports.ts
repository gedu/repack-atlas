// Ports owned by the core (docs/PRD.md §6.1): interfaces only, no
// implementations. Adapters (T5, `src/adapters/**`) provide file/URL/
// dev-server manifest sources and the workspace config reader; the core
// consumes them through these contracts and never imports them.

import type { ParsedFederationManifest } from './manifest-types.js';
import type { AppIntrospectionFacts } from './introspection-types.js';

/**
 * Why a manifest could not be turned into a usable document. The
 * corrupt-vs-missing asymmetry is load-bearing: `missing` means "nothing is
 * served there" (the remote may simply not have the plugin enabled →
 * `MISSING_REMOTE_MANIFEST` finding), while `corrupt` means "an answer
 * exists but we cannot read it" → the doctor reports a named
 * `MANIFEST_UNREADABLE` error for a remote (exit 1) and only gives up
 * (`unableToAnswer`, exit 2) when every remote is unreadable.
 */
export type ManifestLoadFailure = 'missing' | 'corrupt';

/** Outcome of loading one manifest: a parsed document or a typed failure. */
export type ManifestLoadResult =
  | {
      status: 'ok';
      manifest: ParsedFederationManifest;
      /** Where the document was actually read from (path or URL). */
      resolvedFrom: string;
    }
  | {
      status: 'failed';
      failure: ManifestLoadFailure;
      /** Human-readable cause for report messages. */
      message: string;
    };

/**
 * Loads federation manifests by reference (file path, directory, URL, or
 * dev-server address — the reference grammar is the adapter's business).
 * Implementations must never throw: failures come back typed so the rule
 * engine can distinguish "no manifest" from "unreadable manifest".
 */
export interface ManifestSource {
  /**
   * @param ref Optional reference override. Sources constructed around a
   * fixed location (dev-server port) load their own default when omitted;
   * grammar-dispatching sources require it.
   */
  load(ref?: string): Promise<ManifestLoadResult>;
}

/**
 * Reads the Atlas workspace config (`repack-federation.json`). Owned by core
 * so doctor/CLI code can depend on it; the T5 adapter additionally exposes a
 * richer typed API (`load`), while this port keeps the minimal shape the core
 * consumer side promises.
 */
export interface WorkspaceConfigReader {
  /** Parsed config document, or `null` when no file exists up the tree. */
  read(workspaceRoot: string): Promise<unknown>;
}

// --- ProjectFs ----------------------------------------------------------------
//
// The user project's filesystem behind a port (PRD §6.3 wrapper rule: fixtures
// replace the real disk in tests). Kept deliberately small: everything here is
// read-only, because Atlas never writes to a user project (Studio is read-only
// forever, AGENTS.md rule 5; `init` writes go through their own path in T7).

/** The stat facts adapters branch on (file vs directory). */
export interface FileStat {
  isDirectory: boolean;
  sizeBytes: number;
}

/**
 * Read-only view of a filesystem. Implementations must encode absence in the
 * return values (`null` / `false` / empty arrays), not in thrown exceptions,
 * so callers keep the missing-vs-unreadable asymmetry for free: a `null`
 * where a `FileStat` was expected means "cannot answer about this path".
 */
export interface ProjectFs {
  /** Stat the path; `null` when it does not exist or cannot be statted. */
  stat(filePath: string): Promise<FileStat | null>;
  /** `true` when the path exists and is readable. */
  exists(filePath: string): Promise<boolean>;
  /** UTF-8 file contents; `null` when the file cannot be read. */
  readFile(filePath: string): Promise<string | null>;
  /** Entry names of a directory; `[]` when it cannot be listed. */
  readdir(dirPath: string): Promise<string[]>;
  /**
   * Recursive walk yielding `<dir>/entry` paths relative to `rootDir`,
   * sorted for determinism. `ignoreDirNames` prunes directory names
   * (e.g. `['node_modules', 'build']`); an unspecified list uses a
   * sensible default of VCS/dependency/build noise.
   */
  walk(
    rootDir: string,
    options?: { ignoreDirNames?: string[]; maxEntries?: number }
  ): Promise<string[]>;
}

// --- ProcessRunner --------------------------------------------------------------
//
// Spawns long-running workspace processes (bundlers, dev servers). The T9
// runner supervisor consumes this; the contract stays generic.

/** How to start one child process. */
export interface SpawnSpec {
  /** Executable (resolved like a shell would, minus the shell). */
  file: string;
  args?: string[];
  cwd?: string;
  /**
   * Extra environment merged over `process.env`. A key set to `undefined`
   * is REMOVED from the child's environment (a stray inherited value).
   */
  env?: Record<string, string | undefined>;
  /**
   * Run through a shell (`sh -c` / platform equivalent). Needed for
   * `npx`/PATH-wrapped user commands; avoid otherwise.
   */
  shell?: boolean;
  /**
   * Windows only: pass `args` to the child without Node's own quoting (the
   * caller already quoted them, e.g. `cmd.exe /d /s /c "<line>"`).
   */
  windowsVerbatimArguments?: boolean;
}

/** A started child process. */
export interface ProcessHandle {
  /** Child pid, or `null` when the spawn itself failed. */
  readonly pid: number | null;
  /** Stream callback for line-wise consumers (runner log panes). */
  subscribeToStdout(listener: (chunk: string) => void): () => void;
  subscribeToStderr(listener: (chunk: string) => void): () => void;
  /** Resolves once the child exits; never rejects. */
  waitForExit(): Promise<{ code: number | null; signal: string | null }>;
  /** Send a raw signal to the child (not its group). */
  signal(signal: NodeJS.Signals): void;
  /**
   * Kill the whole process group (POSIX: signal to `-pid`), SIGINT first,
   * escalating to SIGTERM after `graceMs`. Best-effort: resolves even when
   * the tree was already gone.
   */
  killTree(graceMs?: number): Promise<void>;
}

/**
 * Spawns and supervises child processes. Implementations put children in
 * their own process group wherever the platform supports it, so `killTree`
 * cannot leave orphans (PRD R7).
 */
export interface ProcessRunner {
  /** Start a long-running child. Never throws for non-zero exit —
   * that is normal operation surfaced via `waitForExit`. */
  start(spec: SpawnSpec): ProcessHandle;
  /** Two-leg busy probe (TCP connect or any HTTP answer) on 127.0.0.1. */
  isPortBusy(port: number): Promise<boolean>;
  /** Allocate a currently-free ephemeral port on 127.0.0.1. */
  findFreePort(): Promise<number>;
}

// --- ConfigIntrospector -----------------------------------------------------------
//
// Per the T0 decision (PRD §16 item 3) Atlas does NOT load user rspack configs
// in-process. Users opt in to the `repack-atlas/introspection` plugin, which
// writes a small JSON facts file into the app; this port reads and validates
// it. Typed results, never throws.

export type IntrospectionFailure = 'missing' | 'invalid';

export type IntrospectionResult =
  | {
      status: 'ok';
      facts: AppIntrospectionFacts;
      /** Path of the JSON document that was read. */
      resolvedFrom: string;
    }
  | {
      status: 'failed';
      failure: IntrospectionFailure;
      message: string;
    };

/**
 * Reads per-app introspection facts (`.repack-atlas/introspection.json`)
 * declared by the opt-in plugin. `missing` means the app simply did not opt
 * in; `invalid` means a malformed declaration exists (report as unusable,
 * never guess around it).
 */
export interface ConfigIntrospector {
  read(appRoot: string): Promise<IntrospectionResult>;
}

// --- ReactNativeCliResolver ----------------------------------------------------
//
// `repack-atlas dev` runs each app with the `react-native` CLI installed in
// that app's OWN root (no PATH lookup, no cross-app fallback). Resolution goes
// through the user project's module graph, so it sits behind a port
// (AGENTS.md rules 3 and 4). Typed result, never throws.

export type ReactNativeCliResult =
  | {
      status: 'ok';
      /** Absolute path of the CLI script (`bin.react-native`). */
      cli: string;
      /**
       * The package manager's `node_modules/.bin/react-native` shim, when
       * one exists. Running it (not `node <cli>`) keeps the environment the
       * shim sets up, e.g. pnpm's `NODE_PATH`, without which the CLI cannot
       * find its platform plugins in a pnpm workspace.
       */
      shim?: string;
    }
  | {
      status: 'failed';
      /** Human-readable cause, naming the app root. */
      message: string;
    };

/**
 * The long option flags (`--port`, `--no-interactive`, ...; value placeholders
 * and aliases stripped) of the `start` command the app's React Native config
 * registers. `unknown` means the set could not be determined (no config, no
 * `start` command, or the config failed to load): callers must then take the
 * safe path rather than assume an option exists.
 */
export type StartOptionsResult =
  | { status: 'ok'; options: readonly string[] }
  | { status: 'unknown'; message: string };

export interface ReactNativeCliResolver {
  /** Resolve `react-native`'s CLI script as the app at `appRoot` would. */
  resolve(appRoot: string): ReactNativeCliResult;
  /** Options the app's registered `start` command declares. Never throws. */
  startOptions(appRoot: string): StartOptionsResult;
}

// --- PromptPort --------------------------------------------------------------------
//
// The interactive `dev` wizard asks questions through this port so the flow
// never knows whether a prompt library or plain readline answers them. Library
// agnostic on purpose: a cancelled prompt (Ctrl-C, closed stdin) is a typed
// result, never a library sentinel or a thrown error.

export interface PromptOption {
  value: string;
  label: string;
}

export type PromptResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'cancelled' };

export interface PromptPort {
  /**
   * One or more of `options`; `initialValues` are pre-selected. With
   * `emptyHint` an empty selection is valid too.
   */
  multiselect(question: {
    message: string;
    options: PromptOption[];
    initialValues?: string[];
    /** When set, an empty selection is allowed and means this; adapters must
     * offer a way to choose it. Exception: the readline adapter's `none`
     * keyword yields to an option literally named `none`, so there the empty
     * selection is unreachable. */
    emptyHint?: string;
  }): Promise<PromptResult<string[]>>;
  /** Exactly one of `options` (its `value`). */
  select(question: {
    message: string;
    options: PromptOption[];
    initialValue?: string;
  }): Promise<PromptResult<string>>;
  confirm(question: {
    message: string;
    initialValue?: boolean;
  }): Promise<PromptResult<boolean>>;
  /** Free text; `validate` returns an error message or `undefined` when fine. */
  text(question: {
    message: string;
    validate?(value: string): string | undefined;
  }): Promise<PromptResult<string>>;
  /** An informational line between questions. */
  note(message: string): void;
  /** Announce that the user walked away (printed once by the caller). */
  cancel(message: string): void;
  /** Release the input stream. Idempotent. */
  close(): void;
}
