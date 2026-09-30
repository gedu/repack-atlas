// The federation graph: the single data shape the Studio renders
// (docs/PRD.md §7.2, G5). Pure and bundler-agnostic by construction — it takes
// already-parsed manifests and returns plain data, so `src/studio/**` only has
// to serve and draw it (owner decision 2026-09-29, odd/tasks/repo-foundation.md).
//
// Determinism is a feature, not cosmetics: the Studio re-renders on every SSE
// push, so equal input must produce byte-identical JSON. Every collection this
// function returns is sorted, and no `Map`/`Set` iteration order leaks into the
// output.
//
// Honesty about granularity (AGENTS.md rule 7) — verified against the fixture
// manifests before writing this, as the plan required:
//   A v1 manifest's `remotes[]` entry is `{ federationContainerName, moduleName,
//   alias, entry }`. In every fixture (and in the shape the vendored builder
//   produces for the common `remotes: { name: url }` config) `moduleName` is
//   just the container name again, i.e. the reference is APP-LEVEL: the
//   manifest proves "host loads mini_auth", never "host loads
//   mini_auth's ./Login". Module-level labels appear only when `moduleName`
//   actually names one of the target's exposed modules (the
//   `container@./Module@url` shorthand). So:
//     - `edge.label` is the expose key (`./Login`) when the manifest really
//       recorded it, and `''` otherwise (`edge.moduleLevel` says which);
//     - `expose.consumers` is populated ONLY from module-level edges — an
//       app-level edge never credits every expose of the target, because that
//       would be a claim the data does not support;
//     - `app.consumedBy` carries the app-level truth, which is all the
//       manifests can prove, and the Studio states the limitation in the UI.

import type { DoctorFinding } from './findings.js';
import type { FederationConfig } from './federation-config.js';
import type {
  ManifestNativeModule,
  ManifestRemoteEntry,
  ManifestSharedEntry,
  ParsedFederationManifest,
} from './manifest-types.js';

/** Runtime state of one app's dev server (filled by the runner, T9). */
export const APP_RUNTIME_STATUSES = [
  'idle',
  'starting',
  'bundling',
  'ready',
  'error',
  'stopped',
] as const;

export type AppRuntimeStatus = (typeof APP_RUNTIME_STATUSES)[number];

/** `appName -> live status`, injected by the serving layer. */
export type AppStatusMap = Record<string, AppRuntimeStatus>;

/** One exposed module plus the apps proven to consume THAT module. */
export interface GraphExpose {
  /** Expose name without the `./` prefix, as the manifest records it. */
  name: string;
  /** Source path of the exposed module. */
  path: string;
  /**
   * Apps whose manifest names this module explicitly (module-level edge).
   * Empty whenever the workspace only carries app-level references — see the
   * granularity note at the top of this file.
   */
  consumers: string[];
}

/** Native-module facts, minus anything the Studio must not invent. */
export type GraphNativeModule = Pick<
  ManifestNativeModule,
  'package' | 'version' | 'turboModule' | 'confidence'
> & { modules: string[] };

/** Detection context needed to keep the Native tab honest (rule 7). */
export interface GraphDetection {
  /** False when this app has no usable manifest: everything else is empty. */
  manifestAvailable: boolean;
  reactNativeVersion?: string;
  newArch?: boolean;
  platforms: string[];
  /** True ⇒ the host native list is not authoritative. */
  dynamicImportDetected: boolean;
}

/** One app node. */
export interface GraphApp {
  /**
   * Reference name, mirroring doctor naming 1:1 so a finding and a node can
   * be read side by side: the host's manifest `name`, each remote's
   * `repack-federation.json` key.
   */
  name: string;
  role: 'host' | 'remote';
  /** Dev-server port when the workspace config or the app declares one. */
  port?: number;
  /**
   * Present (and `true`) only when the workspace config declares
   * `remotes.<name>.standalone: true`. A declaration by the app owner that
   * the remote can run without the host; Atlas neither detects nor verifies
   * it, and the Studio only displays it.
   */
  standalone?: true;
  /** Absent until the serving layer injects live statuses. */
  status?: AppRuntimeStatus;
  exposes: GraphExpose[];
  shared: ManifestSharedEntry[];
  native: GraphNativeModule[];
  /** Apps that reference this app's container (app-level truth). */
  consumedBy: string[];
  detection: GraphDetection;
}

/** One consumption edge. At most one edge per (from, to) pair. */
export interface GraphEdge {
  from: string;
  to: string;
  /**
   * Expose key (`./Login`) when the manifest recorded a module-level
   * reference; `''` for an app-level one. Multiple distinct labels for the
   * same pair are joined with a space — in practice a manifest records one
   * entry per (consumer, container) pair.
   */
  label: string;
  /** True when at least one label was derived from the manifest. */
  moduleLevel: boolean;
  /** True when this edge lies on a directed cycle. */
  cyclic: boolean;
}

/** Everything the Studio page needs, in one serializable object. */
export interface FederationGraph {
  apps: GraphApp[];
  edges: GraphEdge[];
  /** Doctor findings for this workspace, passed through verbatim. */
  findings: DoctorFinding[];
}

/** One app as the caller hands it to the builder. */
export interface FederationGraphInput {
  /** Reference name, used as the node id (see `GraphApp.name`). */
  name: string;
  role: 'host' | 'remote';
  /** Overrides the workspace-config port when given. */
  port?: number;
  /** Omitted/undefined when the app has no usable manifest. */
  manifest?: ParsedFederationManifest;
}

function sharedOf(manifest: ParsedFederationManifest): ManifestSharedEntry[] {
  return Array.isArray(manifest.shared) ? manifest.shared : [];
}

function exposesOf(
  manifest: ParsedFederationManifest
): { name: string; path: string }[] {
  if (!Array.isArray(manifest.exposes)) return [];
  return manifest.exposes.flatMap((entry) =>
    typeof entry?.name === 'string' && typeof entry.path === 'string'
      ? [{ name: entry.name, path: entry.path }]
      : []
  );
}

function nativeOf(manifest: ParsedFederationManifest): GraphNativeModule[] {
  const modules = manifest.reactNative?.nativeModules;
  if (!Array.isArray(modules)) return [];
  return modules
    .filter((entry) => typeof entry?.package === 'string')
    .map((entry) => {
      const confidence: GraphNativeModule['confidence'] =
        entry.confidence === 'heuristic' ? 'heuristic' : 'static';
      return {
        package: entry.package,
        version: typeof entry.version === 'string' ? entry.version : 'unknown',
        turboModule: entry.turboModule === true,
        confidence,
        modules: Array.isArray(entry.modules) ? [...entry.modules].sort() : [],
      };
    })
    .sort((a, b) => a.package.localeCompare(b.package));
}

/**
 * Which app a `remotes[]` entry points at, checked in the order a container
 * reference is usually resolved: alias (what the consumer's code imports),
 * federation container name, module name. `undefined` for a reference to
 * something outside this workspace — that is the doctor's business
 * (`MISSING_REMOTE_MANIFEST`), not an edge.
 */
function resolveTarget(
  remote: ManifestRemoteEntry,
  names: Set<string>
): string | undefined {
  for (const candidate of [
    remote.alias,
    remote.federationContainerName,
    remote.moduleName,
  ]) {
    if (typeof candidate === 'string' && names.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** `./Module` when `moduleName` really names an expose of the target. */
function moduleLabelOf(
  remote: ManifestRemoteEntry,
  targetExposes: Set<string>
): string | undefined {
  if (typeof remote.moduleName !== 'string') return undefined;
  const bare = remote.moduleName.replace(/^\.?\//, '');
  if (bare === '' || bare === remote.alias || bare === remote.federationContainerName) {
    return undefined;
  }
  return targetExposes.has(bare) ? `./${bare}` : undefined;
}

/**
 * Targets reachable from `source` in `steps` or fewer hops, excluding
 * `source` itself unless it is genuinely reachable. Sorted-breadth traversal
 * keeps this deterministic; the graph is tiny so the O(V*E) is irrelevant.
 */
function reaches(
  adjacency: Map<string, string[]>,
  source: string,
  target: string
): boolean {
  const seen = new Set<string>(adjacency.get(source) ?? []);
  let frontier = [...seen];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      if (node === target) return true;
      for (const successor of adjacency.get(node) ?? []) {
        if (!seen.has(successor)) {
          seen.add(successor);
          next.push(successor);
        }
      }
    }
    frontier = next;
  }
  return false;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/**
 * Build the federation graph for one workspace.
 *
 * @param config   validated `repack-federation.json`; supplies the app roster
 *                 (so an app with a missing manifest still gets a node) and
 *                 the declared dev-server ports.
 * @param manifests one entry per app, manifest optional when it could not be
 *                 loaded. Order is irrelevant — output is sorted.
 * @param findings doctor findings for the same workspace, passed through so
 *                 the Studio needs exactly one request.
 * @param options  `statuses` injects the live dev-server state (the builder
 *                 stays pure: the map is data in, not a live lookup).
 */
export function buildFederationGraph(
  config: FederationConfig,
  manifests: FederationGraphInput[],
  findings: DoctorFinding[],
  options: { statuses?: AppStatusMap } = {}
): FederationGraph {
  const statuses = options.statuses ?? {};

  // Roster: the host first (its node name is its manifest `name`, which is
  // exactly what the doctor calls it in messages), then every remote key of
  // the config (the doctor's remote labels), then any extra input the caller
  // supplied. Deduped by name, insertion order irrelevant.
  const hostInput = manifests.find((entry) => entry.role === 'host');
  const hostName =
    (typeof hostInput?.manifest?.name === 'string' &&
      hostInput.manifest.name) ||
    hostInput?.name ||
    'host';

  const inputsByName = new Map<string, FederationGraphInput>();
  for (const input of manifests) {
    if (!inputsByName.has(input.name)) inputsByName.set(input.name, input);
  }
  // Alias the host input under the name its manifest reports, so a node named
  // from the manifest still resolves to the caller's input when the two
  // differ (the plan names the host after its manifest reference).
  if (hostInput && !inputsByName.has(hostName)) {
    inputsByName.set(hostName, hostInput);
  }

  const roster = new Map<
    string,
    { role: 'host' | 'remote'; port?: number; standalone?: true }
  >();
  roster.set(hostName, {
    role: 'host',
    ...(typeof config.host.port === 'number' ? { port: config.host.port } : {}),
  });
  for (const [name, remote] of Object.entries(config.remotes)) {
    roster.set(name, {
      role: 'remote',
      ...(typeof remote.port === 'number' ? { port: remote.port } : {}),
      ...(remote.standalone === true ? { standalone: true as const } : {}),
    });
  }
  for (const input of manifests) {
    if (input !== hostInput && !roster.has(input.name)) {
      roster.set(input.name, {
        role: input.role,
        ...(typeof input.port === 'number' ? { port: input.port } : {}),
      });
    }
  }

  const exposesByApp = new Map<string, Set<string>>();
  for (const [name] of roster) {
    const manifest = inputsByName.get(name)?.manifest;
    exposesByApp.set(
      name,
      new Set(manifest ? exposesOf(manifest).map((entry) => entry.name) : [])
    );
  }

  // Edges: one per (consumer, target) pair, labels unioned.
  type EdgeAccumulator = { labels: Set<string>; moduleLevel: boolean };
  const edgesByKey = new Map<string, EdgeAccumulator>();
  const adjacency: Map<string, string[]> = new Map(
    [...roster.keys()].map((name) => [name, [] as string[]])
  );

  for (const consumer of [...roster.keys()].sort()) {
    const manifest = inputsByName.get(consumer)?.manifest;
    if (!manifest || !Array.isArray(manifest.remotes)) continue;
    for (const remote of manifest.remotes) {
      if (typeof remote !== 'object' || remote === null) continue;
      const target = resolveTarget(remote, new Set(roster.keys()));
      if (!target) continue;
      const key = `${consumer}\u0000${target}`;
      let accumulator = edgesByKey.get(key);
      if (!accumulator) {
        accumulator = { labels: new Set(), moduleLevel: false };
        edgesByKey.set(key, accumulator);
        adjacency.get(consumer)!.push(target);
      }
      const label = moduleLabelOf(remote, exposesByApp.get(target) ?? new Set());
      if (label) {
        accumulator.labels.add(label);
        accumulator.moduleLevel = true;
      }
    }
  }
  for (const [, successors] of adjacency) {
    successors.sort();
  }

  const edges: GraphEdge[] = [...edgesByKey.entries()]
    .map(([key, accumulator]) => {
      const [from, to] = key.split('\u0000') as [string, string];
      const labels = [...accumulator.labels].sort();
      return {
        from,
        to,
        label: labels.join(' '),
        moduleLevel: accumulator.moduleLevel,
        // An edge lies on a cycle exactly when its target can get back to its
        // source (self-references included). Computed here instead of being
        // read off the REMOTE_CYCLE findings: `detectRemoteCycles` reports one
        // finding per strongly-connected component and names a single cycle
        // per component, so it cannot answer "is THIS edge on a cycle". The
        // two answers must stay separate rather than approximated.
        cyclic: from === to || reaches(adjacency, to, from),
      };
    })
    .sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
    );

  const consumedBy = new Map<string, Set<string>>();
  for (const edge of edges) {
    let consumers = consumedBy.get(edge.to);
    if (!consumers) {
      consumers = new Set();
      consumedBy.set(edge.to, consumers);
    }
    consumers.add(edge.from);
  }

  const consumersForModule = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.moduleLevel) continue;
    for (const label of edge.label.split(' ')) {
      const key = `${edge.to}\u0000${label}`;
      let set = consumersForModule.get(key);
      if (!set) {
        set = new Set();
        consumersForModule.set(key, set);
      }
      set.add(edge.from);
    }
  }

  const apps: GraphApp[] = [...roster.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => {
      const input = inputsByName.get(name);
      const role = input?.role ?? entry.role;
      const port = input?.port ?? entry.port;
      const manifest = input?.manifest;

      const exposes: GraphExpose[] = (
        manifest ? exposesOf(manifest) : []
      )
        .map((expose) => ({
          name: expose.name,
          path: expose.path,
          consumers: [
            ...(
              consumersForModule.get(`${name}\u0000./${expose.name}`) ??
              new Set<string>()
            ).keys(),
          ].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const native = manifest ? nativeOf(manifest) : [];
      const nativeBlock = manifest?.reactNative;

      const app: GraphApp = {
        name,
        role,
        exposes,
        shared: manifest
          ? [...sharedOf(manifest)].sort((a, b) => a.name.localeCompare(b.name))
          : [],
        native,
        consumedBy: [...(consumedBy.get(name) ?? [])].sort(),
        detection: {
          manifestAvailable: manifest !== undefined,
          platforms: Array.isArray(nativeBlock?.platforms)
            ? [...nativeBlock.platforms].sort()
            : [],
          dynamicImportDetected: nativeBlock?.dynamicImportDetected === true,
          ...(typeof nativeBlock?.version === 'string'
            ? { reactNativeVersion: nativeBlock.version }
            : {}),
          ...(typeof nativeBlock?.newArch === 'boolean'
            ? { newArch: nativeBlock.newArch }
            : {}),
        },
      };
      if (typeof port === 'number') app.port = port;
      if (entry.standalone === true) app.standalone = true;
      const status = statuses[name];
      if (status !== undefined) app.status = status;
      return app;
    })
    .sort(byName);

  return { apps, edges, findings: [...findings] };
}
