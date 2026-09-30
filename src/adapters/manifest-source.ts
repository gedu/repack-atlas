// `ManifestSource` adapters (docs/PRD.md §6.1): file / URL / dev-server.
//
// Provenance: the reference grammar and failure classification are ported
// from `commands/federation/loadManifest.ts` of callstack/repack @ c5df67f0,
// with two deliberate adaptations to the core port's typed asymmetry
// (`missing` = nothing served there → MISSING_REMOTE_MANIFEST finding;
// `corrupt` = an answer exists but is unreadable → exit 2):
//   - upstream threw `ManifestNotFoundError`/`ManifestInvalidError`; here
//     they map to `{ status: 'failed', failure: 'missing' | 'corrupt' }`
//     and the adapter never throws (port contract).
//   - upstream classified EVERY non-OK HTTP response as "not found". That
//     overstates confidence for 5xx: a dev-server that answers 500 IS an
//     answer we cannot read → `corrupt`. 404/403 stay `missing`.
//   - HTTP reads gained a hard timeout and a size cap: manifest content is
//     untrusted input (AGENTS.md rule 5) and a hung dev-server must not
//     hang the doctor.
//
// The dev-server "convention" is not a third grammar: it is the URL grammar
// with the default manifest filename appended (`http://127.0.0.1:<port>` →
// `http://127.0.0.1:<port>/repack-federation-manifest.json`), exactly as
// upstream's `manifestUrlFrom` did.

import path from 'node:path';
import {
  isParsedFederationManifest,
  type ManifestLoadResult,
  type ManifestSource,
  type ProjectFs,
} from '../core/index.js';
import { DEFAULT_MANIFEST_FILENAME } from '../repack-bridge/index.js';

/** Tunables shared by the URL-shaped sources. */
export interface UrlManifestSourceOptions {
  /** Abort the request (connect + body) after this many ms. Default 5_000. */
  timeoutMs?: number;
  /** Reject bodies larger than this many bytes. Default 1 MiB. */
  maxBytes?: number;
  /** Injectable fetch for tests; defaults to the global. */
  fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function isHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/** Append the default manifest filename unless the URL already names a .json. */
function manifestUrlFrom(base: string): URL {
  const url = new URL(base);
  if (url.pathname.endsWith('.json')) return url;
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.pathname += DEFAULT_MANIFEST_FILENAME;
  return url;
}

/** Read a response body with a hard size cap; rejects the body when over. */
async function readCappedBody(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) {
    return (await response.text()).slice(0, maxBytes + 1);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Parse + minimal-shape-check a manifest body; both failures are corrupt. */
function parseManifestBody(
  content: string,
  resolvedFrom: string
): ManifestLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return {
      status: 'failed',
      failure: 'corrupt',
      message: `Manifest at ${resolvedFrom} is not valid JSON.`,
    };
  }
  if (!isParsedFederationManifest(parsed)) {
    return {
      status: 'failed',
      failure: 'corrupt',
      message:
        `Manifest at ${resolvedFrom} does not look like a federation manifest: ` +
        'it must have a numeric "manifestVersion" and a "name" or "id" string.',
    };
  }
  return { status: 'ok', manifest: parsed, resolvedFrom };
}

/**
 * http(s) manifest source. `ref` is a full URL, optionally without the
 * manifest filename (the default filename is appended, like upstream).
 */
export function createUrlManifestSource(
  options: UrlManifestSourceOptions = {}
): ManifestSource {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async load(ref: string): Promise<ManifestLoadResult> {
      let url: URL;
      try {
        url = manifestUrlFrom(ref);
      } catch {
        return {
          status: 'failed',
          failure: 'corrupt',
          message: `Not a valid URL: ${ref}`,
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Connection refused / timeout / DNS: nothing answered. Upstream
        // called this Invalid; the port's asymmetry says a source that
        // never answered is "nothing there" for a URL (the remote may
        // simply not be running) → missing.
        return {
          status: 'failed',
          failure: 'missing',
          message: `Could not fetch manifest from ${url}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (response.status === 404 || response.status === 403) {
        return {
          status: 'failed',
          failure: 'missing',
          message: `No manifest found at ${url} (HTTP ${response.status}).`,
        };
      }
      if (!response.ok) {
        return {
          status: 'failed',
          failure: 'corrupt',
          message: `Manifest request to ${url} failed (HTTP ${response.status}).`,
        };
      }
      let body: string | null;
      try {
        body = await readCappedBody(response, maxBytes);
      } catch (error) {
        return {
          status: 'failed',
          failure: 'corrupt',
          message: `Could not read manifest response from ${url}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (body === null) {
        return {
          status: 'failed',
          failure: 'corrupt',
          message: `Manifest response from ${url} exceeds the ${maxBytes}-byte limit.`,
        };
      }
      return parseManifestBody(body, url.toString());
    },
  };
}

/**
 * Filesystem manifest source: `ref` is a `.json` file or a directory
 * containing `repack-federation-manifest.json` (upstream grammar), read
 * through the `ProjectFs` port so tests run on fixture trees.
 */
export function createFileManifestSource(fs: ProjectFs): ManifestSource {
  return {
    async load(ref: string): Promise<ManifestLoadResult> {
      const base = path.resolve(ref);
      const info = await fs.stat(base);
      if (info === null) {
        return {
          status: 'failed',
          failure: 'missing',
          message:
            `No manifest found at ${base}. Pass a file, a directory ` +
            `containing ${DEFAULT_MANIFEST_FILENAME}, or a URL.`,
        };
      }
      const filePath = info.isDirectory
        ? path.join(base, DEFAULT_MANIFEST_FILENAME)
        : base;
      const exists = await fs.exists(filePath);
      const content = exists ? await fs.readFile(filePath) : null;
      if (content === null) {
        return {
          status: 'failed',
          failure: 'missing',
          message: `No manifest file at ${filePath}.`,
        };
      }
      return parseManifestBody(content, filePath);
    },
  };
}

/**
 * Dev-server source: the runner/dev-server convention
 * `http://127.0.0.1:<port>` with the default manifest filename appended.
 * A plain alias for the URL source with the host pinned to loopback.
 */
export function createDevServerManifestSource(
  port: number,
  options: UrlManifestSourceOptions = {}
): ManifestSource {
  const base = `http://127.0.0.1:${port}`;
  const urlSource = createUrlManifestSource(options);
  return {
    load(ref?: string): Promise<ManifestLoadResult> {
      // `load()` is called with a ref by core; honor it only when it is
      // already loopback (never let a caller repoint the dev-server source
      // at an arbitrary host — that is what the URL source is for).
      const target = !ref || ref === base ? base : ref;
      if (!/^http:\/\/127\.0\.0\.1(:\d+)?([/?]|$)/.test(target)) {
        return Promise.resolve({
          status: 'failed',
          failure: 'corrupt',
          message: `Dev-server source only accepts loopback URLs, got: ${target}`,
        });
      }
      return urlSource.load(target);
    },
  };
}

/**
 * The default `ManifestSource`: routes any reference by its grammar —
 * http(s) URLs to the URL adapter, everything else to the file adapter —
 * the same dispatch upstream's `loadManifest` performed.
 */
export function createManifestSource(
  fs: ProjectFs,
  options: UrlManifestSourceOptions = {}
): ManifestSource {
  const file = createFileManifestSource(fs);
  const url = createUrlManifestSource(options);
  return {
    load(ref: string): Promise<ManifestLoadResult> {
      return isHttpUrl(ref) ? url.load(ref) : file.load(ref);
    },
  };
}
