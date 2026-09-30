// Atlas-only tests for the REMOTE_CYCLE rule (Studio plan Phase 1 — a rule
// upstream planned but never shipped): no cycle, 2-cycle, 3-cycle,
// self-reference, and a determinism check (same input → identical JSON).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectRemoteCycles, type RemoteGraphNode } from '../../src/core/cycle.js';
import { doctorReportToJson } from '../../src/core/doctor.js';
import { doctorExitCode } from '../../src/core/exit-codes.js';
import type { ParsedFederationManifest } from '../../src/core/manifest-types.js';

function app(name: string, remoteNames: string[]): ParsedFederationManifest {
  return {
    manifestVersion: 1,
    id: name,
    name,
    remotes: remoteNames.map((remote) => ({
      federationContainerName: remote,
      moduleName: remote,
      alias: remote,
      entry: `http://localhost:5000/${remote}.container.js`,
    })),
  };
}

function node(name: string, remoteNames: string[]): RemoteGraphNode {
  return { name, manifest: app(name, remoteNames) };
}

function cycleMessages(nodes: RemoteGraphNode[]): string[] {
  return detectRemoteCycles(nodes)
    .filter((finding) => finding.code === 'REMOTE_CYCLE')
    .map((finding) => finding.message);
}

describe('detectRemoteCycles', () => {
  it('finds nothing in an acyclic host -> remotes fan-out', () => {
    const findings = detectRemoteCycles([
      node('shell', ['store', 'auth']),
      node('store', []),
      node('auth', []),
    ]);
    assert.deepEqual(findings, []);
  });

  it('finds nothing when edges point to apps outside the graph', () => {
    // store -> payments, but payments has no manifest in this run: no cycle
    // can be proven, and none exists.
    const findings = detectRemoteCycles([
      node('shell', ['store']),
      node('store', ['payments']),
    ]);
    assert.deepEqual(findings, []);
  });

  it('detects a 2-cycle naming it Store -> Auth -> Store', () => {
    const messages = cycleMessages([
      node('shell', ['store']),
      node('store', ['auth']),
      node('auth', ['store']),
    ]);
    assert.equal(messages.length, 1);
    // Cycle rendering is deterministic: the search starts from the
    // alphabetically first member of the component.
    assert.ok(messages[0]!.includes('auth -> store -> auth'));
  });

  it('detects a 3-cycle and reports one finding for the component', () => {
    const messages = cycleMessages([
      node('shell', ['a']),
      node('a', ['b']),
      node('b', ['c']),
      node('c', ['a']),
    ]);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]!.includes('a -> b -> c -> a'));
  });

  it('detects a self-referencing remote', () => {
    const messages = cycleMessages([
      node('shell', ['loop']),
      node('loop', ['loop']),
    ]);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]!.includes('loop -> loop'));
  });

  it('only reports cycles, leaving acyclic parts of the graph untouched', () => {
    const messages = cycleMessages([
      node('shell', ['store']),
      node('store', []),
      node('auth', ['auth']),
    ]);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]!.includes('auth -> auth'));
  });

  it('is a warning, never an error (a cycle-only report exits 0)', () => {
    const findings = detectRemoteCycles([
      node('shell', ['store']),
      node('store', ['shell']),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'warning');
    assert.equal(doctorExitCode({ findings }), 0);
  });

  it('reports each disjoint cycle as its own finding', () => {
    const messages = cycleMessages([
      node('shell', ['a', 'x']),
      node('a', ['b']),
      node('b', ['a']),
      node('x', ['y']),
      node('y', ['x']),
    ]);
    assert.equal(messages.length, 2);
    assert.ok(messages.some((m) => m.includes('a -> b -> a')));
    assert.ok(messages.some((m) => m.includes('x -> y -> x')));
  });

  it('is deterministic: the same input yields identical JSON twice', () => {
    // Nodes intentionally inserted out of alphabetical order so a
    // Map/Set-insertion-order-dependent implementation would drift.
    const build = () => [
      node('zeta', ['alpha']),
      node('mid', ['zeta']),
      node('alpha', ['mid']),
      node('beta', ['alpha']),
      node('shell', ['zeta', 'beta', 'mid']),
    ];
    const first = doctorReportToJson({ findings: detectRemoteCycles(build()) });
    const second = doctorReportToJson({ findings: detectRemoteCycles(build()) });
    assert.equal(first, second);
    assert.ok(first.includes('alpha -> mid -> zeta -> alpha'));
  });
});
