// Unit tests for the Studio graph builder (`src/core/graph.ts`).
//
// The fixture workspaces are the primary input: the graph must agree with what
// the manifests actually record — including the granularity limits documented
// in graph.ts (app-level references do NOT credit individual exposes). One
// synthetic manifest covers the module-level case, because no checked-in
// fixture records module names.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  buildFederationGraph,
  buildSharedMatrix,
  runDoctor,
  validateFederationConfig,
  type FederationConfig,
  type FederationGraphInput,
  type GraphApp,
  type ManifestSharedEntry,
  type ParsedFederationManifest,
  type SharedMatrix,
  type SharedMatrixCell,
} from '../../src/core/index.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures'
);

async function loadWorkspace(dir: string): Promise<{
  config: FederationConfig;
  inputs: FederationGraphInput[];
  findings: ReturnType<typeof runDoctor>['findings'];
}> {
  const root = path.join(fixturesDir, dir);
  const configPath = path.join(root, 'repack-federation.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8')) as FederationConfig;
  assert.deepEqual(validateFederationConfig(config), [], `${dir}: config invalid`);

  const hostDocument = JSON.parse(
    await readFile(path.resolve(root, config.host.manifest), 'utf-8')
  ) as ParsedFederationManifest;

  const inputs: FederationGraphInput[] = [
    { name: hostDocument.name || 'host', role: 'host', manifest: hostDocument },
  ];
  const remotes = [];
  for (const [name, remote] of Object.entries(config.remotes)) {
    try {
      const manifest = JSON.parse(
        await readFile(path.resolve(root, remote.manifest), 'utf-8')
      ) as ParsedFederationManifest;
      inputs.push({ name, role: 'remote', manifest });
      remotes.push({ name, manifest });
    } catch {
      remotes.push({ name, missing: true });
    }
  }

  return {
    config,
    inputs,
    findings: runDoctor({ host: hostDocument, remotes }).findings,
  };
}

describe('buildFederationGraph over the clean workspace fixture', () => {
  it('one node per app, host named like the doctor names it', async () => {
    const { config, inputs, findings } = await loadWorkspace('workspace');
    const graph = buildFederationGraph(config, inputs, findings);

    assert.deepEqual(
      graph.apps.map((app) => `${app.name}:${app.role}`),
      ['host:host', 'mini_auth:remote', 'mini_store:remote']
    );
    assert.equal(graph.apps[1]?.port, 8082);
    assert.equal(graph.apps[2]?.port, 8083);
    assert.equal(graph.apps[0]?.port, undefined, 'the host declares no port in the config');
  });

  it('edges carry app references, exposes list what the manifest exposes', async () => {
    const { config, inputs, findings } = await loadWorkspace('workspace');
    const graph = buildFederationGraph(config, inputs, findings);

    assert.deepEqual(
      graph.edges.map((edge) => `${edge.from}->${edge.to} "${edge.label}"`),
      ['host->mini_auth ""', 'host->mini_store ""']
    );
    assert.equal(
      graph.edges.every((edge) => edge.cyclic === false),
      true,
      'the clean workspace has no cycles'
    );

    // Granularity honesty: these manifests record `moduleName: "mini_auth"`,
    // i.e. the container, not a module. The graph must not invent labels and
    // must not credit every expose of the target.
    assert.equal(
      graph.edges.every((edge) => edge.moduleLevel === false),
      true,
      'app-level references stay app-level'
    );
    const auth = graph.apps.find((app) => app.name === 'mini_auth');
    assert.deepEqual(auth?.exposes, [
      { name: 'Login', path: './src/Login', consumers: [] },
    ]);
    assert.deepEqual(auth?.consumedBy, ['host']);
    assert.equal(
      auth?.exposes[0]?.consumers.length,
      0,
      'an app-level edge must not be reported as a module consumer'
    );
  });

  it('passes shared, native and detection through, sorted', async () => {
    const { config, inputs, findings } = await loadWorkspace('workspace');
    const graph = buildFederationGraph(config, inputs, findings);
    const store = graph.apps.find((app) => app.name === 'mini_store');

    assert.deepEqual(store?.shared.map((entry) => entry.name), ['react', 'react-native']);
    assert.deepEqual(store?.native.map((entry) => entry.package), ['react-native-reanimated']);
    assert.deepEqual(store?.detection.platforms, ['android', 'ios']);
    assert.equal(store?.detection.reactNativeVersion, '0.79.2');
    assert.equal(store?.detection.manifestAvailable, true);
    assert.equal(store?.detection.dynamicImportDetected, false);
  });

  it('carries standalone only for a remote that declares it', async () => {
    const { config, inputs, findings } = await loadWorkspace('workspace');
    const explicitFalse: FederationConfig = {
      ...config,
      remotes: {
        ...config.remotes,
        mini_store: { ...config.remotes['mini_store']!, standalone: false },
      },
    };
    const none = buildFederationGraph(explicitFalse, inputs, findings);
    assert.equal(explicitFalse.remotes['mini_store']?.standalone, false);
    assert.equal(
      none.apps.every((app) => !('standalone' in app)),
      true,
      'an explicit standalone: false is not carried'
    );

    const declared: FederationConfig = {
      ...config,
      remotes: {
        ...config.remotes,
        mini_auth: { ...config.remotes['mini_auth']!, standalone: true },
      },
    };
    const graph = buildFederationGraph(declared, inputs, findings);
    assert.equal(graph.apps.find((app) => app.name === 'mini_auth')?.standalone, true);
    assert.equal('standalone' in graph.apps.find((app) => app.name === 'mini_store')!, false);
    assert.equal('standalone' in graph.apps.find((app) => app.name === 'host')!, false);
    const wire = JSON.parse(JSON.stringify(graph)) as { apps: { name: string; standalone?: boolean }[] };
    assert.equal(
      wire.apps.find((app) => app.name === 'mini_auth')?.standalone,
      true,
      'reaches /api/graph JSON'
    );
  });

  it('injects statuses only when the caller supplies them', async () => {
    const { config, inputs, findings } = await loadWorkspace('workspace');
    const without = buildFederationGraph(config, inputs, findings);
    assert.equal(
      without.apps.every((app) => app.status === undefined),
      true
    );

    const withStatuses = buildFederationGraph(config, inputs, findings, {
      statuses: { mini_auth: 'bundling', host: 'ready' },
    });
    assert.equal(withStatuses.apps.find((a) => a.name === 'host')?.status, 'ready');
    assert.equal(
      withStatuses.apps.find((a) => a.name === 'mini_auth')?.status,
      'bundling'
    );
    assert.equal(withStatuses.apps.find((a) => a.name === 'mini_store')?.status, undefined);
  });

  it('is deterministic: the same input yields byte-identical JSON, twice and reversed', async () => {
    const { config, inputs, findings } = await loadWorkspace('workspace');
    const first = buildFederationGraph(config, inputs, findings, {
      statuses: { host: 'ready' },
    });
    const second = buildFederationGraph(config, [...inputs].reverse(), findings, {
      statuses: { host: 'ready' },
    });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});

describe('buildFederationGraph over the cycle fixture', () => {
  it('marks every edge on the cycle cyclic and keeps the finding', async () => {
    const { config, inputs, findings } = await loadWorkspace('fixture-remote-cycle');
    assert.ok(
      findings.some((finding) => finding.code === 'REMOTE_CYCLE'),
      'the fixture must still provoke REMOTE_CYCLE for this test to mean anything'
    );
    const graph = buildFederationGraph(config, inputs, findings);

    assert.deepEqual(
      graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.cyclic ? 'cyclic' : 'plain'}`),
      [
        'host->mini_auth:plain',
        'host->mini_store:plain',
        'mini_auth->mini_store:cyclic',
        'mini_store->mini_auth:cyclic',
      ]
    );
    assert.deepEqual(graph.findings, findings, 'findings pass through verbatim');
  });
});

describe('buildFederationGraph over the Studio rendering probe fixture', () => {
  it('treats hostile strings as opaque data', async () => {
    const { config, inputs, findings } = await loadWorkspace('fixture-xss');
    const graph = buildFederationGraph(config, inputs, findings);
    assert.deepEqual(findings, [], 'the probes must not change doctor output');

    const host = graph.apps.find((app) => app.role === 'host');
    assert.equal(host?.name, 'host<img src=x onerror=alert(6)>');
    const store = graph.apps.find((app) => app.name === 'mini_store');
    assert.equal(store?.exposes[0]?.name, '<script>alert(1)</script>');
    assert.equal(store?.exposes[0]?.path, './src/<img src=x onerror=alert(2)>');
    assert.ok(store?.shared.some((entry) => entry.name.includes('<svg onload')));
    assert.ok(store?.native.length === 1);
    assert.ok(host?.native.some((entry) => entry.package === '<script>alert(4)</script>'));
    // Names are data: the host node is still the host, still wired to both.
    assert.deepEqual(
      graph.edges.map((edge) => edge.to).sort(),
      ['mini_auth', 'mini_store']
    );
  });
});

// The shared matrix is the Studio's Compare view (issue #73): the doctor's own
// host↔remote comparison projected over every app at once. These tests pin the
// statuses to the doctor branches they mirror, and pin what the matrix must
// NOT claim (remote↔remote is #55; `unknown` is never a pass).
function describeMatrix(graph: ReturnType<typeof buildFederationGraph>): string[] {
  return graph.sharedMatrix.rows.map(
    (row) =>
      `${row.package} [${row.singleton ? 'singleton' : 'any'}] ` +
      row.cells.map((cell) => `${cell.app}=${cell.status}/${cell.version}`).join(' ')
  );
}

describe('buildSharedMatrix over the workspace fixtures', () => {
  it('marks the reference host cell and the remotes that agree with it', async () => {
    const { config, inputs, findings } = await loadWorkspace('workspace');
    const graph = buildFederationGraph(config, inputs, findings);

    assert.equal(graph.sharedMatrix.referenceApp, 'host');
    assert.deepEqual(
      graph.sharedMatrix.apps,
      ['host', 'mini_auth', 'mini_store'],
      'the reference column comes first, remotes stay alphabetical'
    );
    assert.deepEqual(describeMatrix(graph), [
      'react [singleton] host=reference/19.0.0 mini_auth=match/19.0.0 mini_store=match/19.0.0',
      'react-native [singleton] host=reference/0.79.2 mini_auth=match/0.79.2 mini_store=match/0.79.2',
    ]);
  });

  it('marks the drifted singleton the same way the doctor does', async () => {
    const { config, inputs, findings } = await loadWorkspace('fixture-version-drift');
    const graph = buildFederationGraph(config, inputs, findings);

    assert.ok(
      findings.some((finding) => finding.code === 'SHARED_VERSION_DRIFT'),
      'the fixture must still provoke the drift this matrix mirrors'
    );
    assert.deepEqual(describeMatrix(graph), [
      'react [singleton] host=reference/19.0.0 mini_auth=match/19.0.0 mini_store=drift/19.1.0',
      'react-native [singleton] host=reference/0.79.2 mini_auth=match/0.79.2 mini_store=match/0.79.2',
    ]);
  });

  it('is deterministic: equal input produces byte-identical JSON', async () => {
    const { config, inputs, findings } = await loadWorkspace('fixture-version-drift');
    const graph = buildFederationGraph(config, inputs, findings);
    const first = graph.sharedMatrix;

    assert.equal(
      JSON.stringify(buildFederationGraph(config, [...inputs].reverse(), findings).sharedMatrix),
      JSON.stringify(first),
      'input order must not leak into the matrix'
    );
    assert.equal(
      JSON.stringify(buildSharedMatrix(graph.apps)),
      JSON.stringify(first),
      'buildSharedMatrix is a pure function of the app list the graph already carries'
    );
  });
});

describe('buildSharedMatrix edge cases', () => {
  const shared = (overrides: Partial<ManifestSharedEntry> = {}) => ({
    name: 'react',
    version: '19.0.0',
    singleton: true,
    eager: true,
    requiredVersion: '^19.0.0',
    ...overrides,
  });

  function matrixOf(
    hostShared: ManifestSharedEntry[] | undefined,
    remoteShared: ManifestSharedEntry[] | undefined
  ) {
    const config = {
      host: { manifest: './host.json' },
      remotes: { wallet: { manifest: './wallet.json', port: 9000 } },
    } as FederationConfig;
    // exactOptionalPropertyTypes: `shared` is omitted, never set to undefined.
    const graph = buildFederationGraph(
      config,
      [
        {
          name: 'host',
          role: 'host',
          manifest: {
            manifestVersion: 1,
            id: 'host',
            name: 'host',
            ...(hostShared ? { shared: hostShared } : {}),
          },
        },
        {
          name: 'wallet',
          role: 'remote',
          manifest: {
            manifestVersion: 1,
            id: 'wallet',
            name: 'wallet',
            ...(remoteShared ? { shared: remoteShared } : {}),
          },
        },
      ],
      []
    );
    return graph.sharedMatrix;
  }

  const CELL = (matrix: SharedMatrix, pkg: string, app: string): SharedMatrixCell =>
    matrix.rows.find((row) => row.package === pkg)!.cells.find((cell) => cell.app === app)!;

  it('reports unknown versions as unknown, never as a match', () => {
    const matrix = matrixOf([shared()], [shared({ version: 'unknown' })]);

    assert.equal(CELL(matrix, 'react', 'wallet').status, 'unknown');
    assert.equal(CELL(matrix, 'react', 'wallet').declared, true);
    assert.equal(
      CELL(matrix, 'react', 'host').status,
      'reference',
      'a known host version does not rescue the unknown remote side'
    );
  });

  it('reports an unknown on the reference side without inventing a verdict', () => {
    const matrix = matrixOf([shared({ version: 'unknown' })], [shared()]);

    assert.equal(CELL(matrix, 'react', 'host').status, 'reference');
    assert.equal(CELL(matrix, 'react', 'wallet').status, 'unknown');
  });

  it('separates a singleton disagreement from a version drift', () => {
    const matrix = matrixOf([shared({ singleton: true })], [shared({ singleton: false })]);

    assert.equal(CELL(matrix, 'react', 'wallet').status, 'singleton-mismatch');
  });

  it('keeps non-singleton packages neutral even when the versions differ', () => {
    const matrix = matrixOf(
      [shared({ singleton: false })],
      [shared({ singleton: false, version: '18.2.0' })]
    );

    assert.equal(matrix.rows[0]?.singleton, false, 'the row records the reference declaration');
    assert.equal(CELL(matrix, 'react', 'wallet').status, 'coexist');
  });

  it('marks packages one side does not declare instead of inventing a comparison', () => {
    const matrix = matrixOf([shared()], [shared({ name: 'zustand' })]);

    assert.deepEqual(
      matrix.rows.map((row) => `${row.package}:${row.cells.map((c) => c.status).join(',')}`),
      ['react:reference,absent', 'zustand:absent,uncompared'],
      'a package the host never declares has nothing to be compared against'
    );
    assert.equal(CELL(matrix, 'zustand', 'wallet').declared, true);
    assert.equal(CELL(matrix, 'zustand', 'host').declared, false);
    assert.equal(CELL(matrix, 'zustand', 'wallet').version, '19.0.0');
  });

  it('does not claim a remote-only singleton is not a singleton', () => {
    // The host declares react only; the remote declares a SINGLETON the host
    // never mentions. The row's singleton flag comes from the reference, so
    // without referenceDeclares the page would print a confident `no` for
    // something the reference never spoke about (AGENTS.md rule 7).
    const matrix = matrixOf([shared()], [shared({ name: 'zustand', singleton: true })]);
    const row = matrix.rows.find((entry) => entry.package === 'zustand')!;

    assert.equal(row.referenceDeclares, false, 'the host never declared this package');
    assert.equal(row.singleton, false, 'the row flag stays the reference declaration');
    assert.equal(
      CELL(matrix, 'zustand', 'wallet').singleton,
      true,
      'the remote own declaration is still on the cell, unmodified'
    );
  });

  it('records the reference declaration for packages the host does declare', () => {
    const matrix = matrixOf([shared({ singleton: false })], [shared({ singleton: false })]);

    assert.equal(matrix.rows[0]?.referenceDeclares, true);
    assert.equal(matrix.rows[0]?.singleton, false, 'the host really said: not a singleton');
  });

  it('handles an app with no manifest and an app with no shared declarations', () => {
    const config = {
      host: { manifest: './host.json' },
      remotes: {
        wallet: { manifest: './wallet.json', port: 9000 },
        ghost: { manifest: './ghost.json', port: 9001 },
      },
    } as FederationConfig;
    const graph = buildFederationGraph(
      config,
      [
        {
          name: 'host',
          role: 'host',
          manifest: { manifestVersion: 1, id: 'host', name: 'host', shared: [shared()] },
        },
        {
          name: 'wallet',
          role: 'remote',
          manifest: { manifestVersion: 1, id: 'wallet', name: 'wallet' },
        },
        { name: 'ghost', role: 'remote' },
      ],
      []
    );

    assert.deepEqual(graph.sharedMatrix.apps, ['host', 'ghost', 'wallet']);
    assert.deepEqual(
      graph.sharedMatrix.rows[0]!.cells.map((cell) => `${cell.app}=${cell.status}/${cell.declared}`),
      ['host=reference/true', 'ghost=absent/false', 'wallet=absent/false']
    );
  });

  it('shows remote data without a verdict when the host declares nothing', () => {
    // Reality check while writing this: `buildFederationGraph` always puts a
    // host node in the roster (it names it after the host manifest, falling
    // back to `host`), so a graph never lacks the column — what it can lack is
    // a host MANIFEST, which is the case that must not invent verdicts.
    const config = {
      host: { manifest: './host.json' },
      remotes: { wallet: { manifest: './wallet.json', port: 9000 } },
    } as FederationConfig;
    const graph = buildFederationGraph(
      config,
      [
        { name: 'host', role: 'host' },
        {
          name: 'wallet',
          role: 'remote',
          manifest: {
            manifestVersion: 1,
            id: 'wallet',
            name: 'wallet',
            shared: [shared(), shared({ name: 'react-native', version: '0.79.2' })],
          },
        },
      ],
      []
    );

    assert.equal(graph.sharedMatrix.referenceApp, 'host');
    assert.deepEqual(
      graph.sharedMatrix.rows.map((row) => row.cells.map((cell) => cell.status)),
      [['absent', 'uncompared'], ['absent', 'uncompared']],
      'the remote versions are still on the wire, just never as a verdict'
    );
    assert.equal(
      graph.sharedMatrix.rows[0]?.cells[1]?.version,
      '19.0.0',
      'uncompared cells keep their data'
    );
  });

  it('compares nothing for an app list with no host at all', () => {
    // The exported pure function can be handed a roster with no host; the
    // builder never produces one today, so this pins the contract directly.
    const app = (name: string, role: 'host' | 'remote'): GraphApp => ({
      name,
      role,
      exposes: [],
      shared: [shared()],
      native: [],
      consumedBy: [],
      detection: { manifestAvailable: true, platforms: [], dynamicImportDetected: false },
    });
    const matrix = buildSharedMatrix([app('wallet', 'remote'), app('other', 'remote')]);

    assert.equal(matrix.referenceApp, undefined);
    assert.deepEqual(matrix.apps, ['other', 'wallet'], 'alphabetical without a reference');
    assert.deepEqual(
      matrix.rows.map((row) => row.cells.map((cell) => cell.status)),
      [['uncompared', 'uncompared']],
      'no reference means no verdict anywhere (that is #55 territory)'
    );
    assert.equal(matrix.rows[0]?.singleton, false, 'no reference means no row label to trust');
    assert.equal(matrix.rows[0]?.referenceDeclares, false);
  });

  it('treats a hostile package name as opaque data', () => {
    const hostile = '<svg onload=alert(7)>';
    const matrix = matrixOf([shared({ name: hostile })], [shared({ name: hostile })]);

    assert.equal(matrix.rows[0]?.package, hostile);
    assert.equal(CELL(matrix, hostile, 'wallet').status, 'match');
  });
});

describe('buildFederationGraph with module-level references', () => {
  // No checked-in fixture records module names (verified: every `moduleName`
  // equals its container name), so this shape comes from the
  // `container@./Module@url` shorthand the vendored builder also produces.
  const remote: ParsedFederationManifest = {
    manifestVersion: 1,
    id: 'wallet',
    name: 'wallet',
    exposes: [
      { id: 'wallet:Screen', name: 'Screen', path: './src/Screen' },
      { id: 'wallet:Hidden', name: 'Hidden', path: './src/Hidden' },
    ],
  };
  const hostManifest: ParsedFederationManifest = {
    manifestVersion: 1,
    id: 'host',
    name: 'host',
    remotes: [
      {
        federationContainerName: 'wallet',
        moduleName: 'Screen',
        alias: 'wallet',
        entry: 'http://127.0.0.1:9000/wallet.container.js',
      },
    ],
  };
  const config = {
    host: { manifest: './host.json' },
    remotes: { wallet: { manifest: './wallet.json', port: 9000 } },
  } as FederationConfig;

  it('labels the edge with the expose key and credits only that module', () => {
    const graph = buildFederationGraph(
      config,
      [
        { name: 'host', role: 'host', manifest: hostManifest },
        { name: 'wallet', role: 'remote', manifest: remote },
      ],
      []
    );

    assert.deepEqual(graph.edges, [
      { from: 'host', to: 'wallet', label: './Screen', moduleLevel: true, cyclic: false },
    ]);
    const wallet = graph.apps.find((app) => app.name === 'wallet');
    assert.deepEqual(
      wallet?.exposes.map((entry) => `${entry.name}:${entry.consumers.join('|')}`),
      ['Hidden:', 'Screen:host'],
      'only the referenced module gains a consumer'
    );
  });

  it('ignores a module name that is not an expose of the target', () => {
    const graph = buildFederationGraph(
      config,
      [
        {
          name: 'host',
          role: 'host',
          manifest: {
            ...hostManifest,
            remotes: [
              { ...hostManifest.remotes![0]!, moduleName: 'NotExposed' },
            ],
          },
        },
        { name: 'wallet', role: 'remote', manifest: remote },
      ],
      []
    );
    assert.deepEqual(graph.edges, [
      { from: 'host', to: 'wallet', label: '', moduleLevel: false, cyclic: false },
    ]);
  });

  it('keeps a node for an app whose manifest could not be loaded', () => {
    const graph = buildFederationGraph(
      config,
      [{ name: 'host', role: 'host', manifest: { manifestVersion: 1, id: 'host', name: 'host' } }],
      []
    );
    const wallet = graph.apps.find((app) => app.name === 'wallet');
    assert.deepEqual(
      {
        role: wallet?.role,
        port: wallet?.port,
        exposes: wallet?.exposes,
        shared: wallet?.shared,
        native: wallet?.native,
        detection: wallet?.detection,
      },
      {
        role: 'remote',
        port: 9000,
        exposes: [],
        shared: [],
        native: [],
        detection: {
          manifestAvailable: false,
          platforms: [],
          dynamicImportDetected: false,
        },
      }
    );
  });

  it('carries the host port from the config onto the host node', () => {
    const hostConfig = {
      host: { manifest: './host.json', port: 8081 },
      remotes: { wallet: { manifest: './wallet.json', port: 9000 } },
    } as FederationConfig;
    const graph = buildFederationGraph(
      hostConfig,
      [{ name: 'host', role: 'host', manifest: hostManifest }],
      []
    );
    assert.equal(graph.apps.find((app) => app.role === 'host')?.port, 8081);
  });

  it('keeps the host port when the host manifest is missing', () => {
    const graph = buildFederationGraph(
      {
        host: { manifest: './host.json', port: 8081 },
        remotes: {},
      } as FederationConfig,
      [],
      []
    );
    const host = graph.apps.find((app) => app.role === 'host');
    assert.equal(host?.name, 'host');
    assert.equal(host?.port, 8081);
  });

  it('keeps the host port when the manifest name differs from the config key', () => {
    const graph = buildFederationGraph(
      {
        host: { manifest: './host.json', port: 8081 },
        remotes: {},
      } as FederationConfig,
      [
        {
          name: 'host',
          role: 'host',
          manifest: { manifestVersion: 1, id: 'super_app', name: 'super_app' },
        },
      ],
      []
    );
    const host = graph.apps.find((app) => app.role === 'host');
    assert.equal(host?.port, 8081);
    assert.equal(graph.apps.filter((app) => app.role === 'host').length, 1);
  });

  it('flags a self-referencing app as cyclic', () => {
    const graph = buildFederationGraph(
      { host: { manifest: './h.json' }, remotes: {} } as FederationConfig,
      [
        {
          name: 'loop',
          role: 'host',
          manifest: {
            manifestVersion: 1,
            id: 'loop',
            name: 'loop',
            remotes: [
              {
                federationContainerName: 'loop',
                moduleName: 'loop',
                alias: 'loop',
                entry: 'http://127.0.0.1:1/loop.container.js',
              },
            ],
          },
        },
      ],
      []
    );
    assert.deepEqual(graph.edges, [
      { from: 'loop', to: 'loop', label: '', moduleLevel: false, cyclic: true },
    ]);
  });
});
