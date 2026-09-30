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
  runDoctor,
  validateFederationConfig,
  type FederationConfig,
  type FederationGraphInput,
  type ParsedFederationManifest,
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
