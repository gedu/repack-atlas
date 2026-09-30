// REMOTE_CYCLE: directed cycle detection over the `remotes[]` edges of a
// host + remote manifest set (Studio plan Phase 1 — a rule upstream planned
// but never shipped).
//
// Pure and deterministic: nodes and adjacency are processed in sorted order
// and each cycle path is rendered from a shortest-path BFS, so the same input
// always produces byte-identical findings (no Set/Map insertion-order
// nondeterminism). Severity is 'warning': a cycle is a structural smell that
// can deadlock container initialization at runtime, not a version lie, so it
// never moves the doctor exit code off 0 (AGENTS.md rule 6).

import type { DoctorFinding } from './findings.js';
import type {
  ManifestRemoteEntry,
  ParsedFederationManifest,
} from './manifest-types.js';

/** One app in the remote graph: its reference name plus its manifest, if any. */
export interface RemoteGraphNode {
  /** Name used to refer to the node in findings and cycle paths. */
  name: string;
  /** Its manifest, when available (missing manifests carry no outgoing edges). */
  manifest?: ParsedFederationManifest | undefined;
}

type Adjacency = Map<string, string[]>;

/** Edge target as the manifest refers to it; alias wins over container name. */
function edgeTarget(remote: ManifestRemoteEntry): string {
  return remote.alias || remote.federationContainerName;
}

/**
 * Strongly connected components (iterative Tarjan, to keep the core free of
 * recursion-depth limits) over a deterministic adjacency map. Roots and
 * successors are traversed in sorted order, so component membership and
 * order never depend on insertion order.
 */
function stronglyConnectedComponents(adjacency: Adjacency): string[][] {
  const nodes = [...adjacency.keys()].sort();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let next = 0;

  interface Frame {
    node: string;
    successors: string[];
    i: number;
  }
  const frames: Frame[] = [];

  for (const root of nodes) {
    if (index.has(root)) continue;
    frames.push({ node: root, successors: adjacency.get(root) ?? [], i: 0 });
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.i === 0) {
        index.set(frame.node, next);
        low.set(frame.node, next);
        next += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }
      if (frame.i < frame.successors.length) {
        const successor = frame.successors[frame.i]!;
        frame.i += 1;
        if (!index.has(successor)) {
          frames.push({
            node: successor,
            successors: adjacency.get(successor) ?? [],
            i: 0,
          });
        } else if (onStack.has(successor)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node)!, index.get(successor)!)
          );
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(
          parent.node,
          Math.min(low.get(parent.node)!, low.get(frame.node)!)
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component.sort());
      }
    }
  }
  return components;
}

/**
 * Shortest cycle through `start` inside the component, found by BFS over
 * sorted adjacency (deterministic tie-breaking). Every node of a non-trivial
 * SCC lies on at least one cycle through it, so a cycle always exists.
 */
function shortestCycleThrough(
  start: string,
  adjacency: Adjacency,
  inside: Set<string>
): string[] {
  const previous = new Map<string, string>();
  const queue: string[] = [start];
  for (const u of queue) {
    for (const v of adjacency.get(u) ?? []) {
      if (!inside.has(v)) continue;
      if (v === start && u !== start) {
        // Walk the BFS parent chain back to `start`, then render forward.
        const path: string[] = [];
        for (let at: string | undefined = u; at; at = previous.get(at)) {
          path.unshift(at);
          if (at === start) break;
        }
        return [...path, start];
      }
      if (!previous.has(v) && v !== start) {
        previous.set(v, u);
        queue.push(v);
      }
    }
  }
  // Unreachable for a well-formed SCC; an empty path means no finding.
  return [];
}

/** Build the sorted adjacency map for the given nodes. */
function buildAdjacency(nodes: RemoteGraphNode[]): Adjacency {
  const adjacency: Adjacency = new Map();
  for (const node of nodes) {
    if (!node.name || adjacency.has(node.name)) continue;
    adjacency.set(node.name, []);
  }
  for (const node of nodes) {
    if (!node.name || !node.manifest) continue;
    const targets = new Set<string>();
    for (const remote of node.manifest.remotes ?? []) {
      const target = edgeTarget(remote);
      // Only edges to apps present in the graph can close a cycle.
      if (target && adjacency.has(target)) targets.add(target);
    }
    adjacency.set(node.name, [...targets].sort());
  }
  return adjacency;
}

/**
 * Detect directed cycles across the `remotes[]` edges of the given nodes and
 * return one `REMOTE_CYCLE` warning per strongly connected component, with a
 * message naming a concrete cycle (e.g. `Store -> Auth -> Store`).
 */
export function detectRemoteCycles(nodes: RemoteGraphNode[]): DoctorFinding[] {
  const adjacency = buildAdjacency(nodes);
  const findings: DoctorFinding[] = [];

  for (const component of stronglyConnectedComponents(adjacency)) {
    let cycle: string[] = [];
    if (component.length === 1) {
      const only = component[0]!;
      if (adjacency.get(only)?.includes(only)) cycle = [only, only];
    } else {
      cycle = shortestCycleThrough(component[0]!, adjacency, new Set(component));
    }
    if (cycle.length === 0) continue;
    findings.push({
      severity: 'warning',
      code: 'REMOTE_CYCLE',
      message:
        `Federation remote cycle detected: ${cycle.join(' -> ')}. ` +
        'Each container in the cycle consumes another one of them, so loading ' +
        'one of them can never fully resolve; break the cycle or share the ' +
        'code through a separate package.',
      confidence: 'static',
    });
  }
  return findings;
}
