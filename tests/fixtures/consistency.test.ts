// T6 fixture-workspace consistency guard.
//
// Every workspace under fixtures/ claims (in its README) which doctor finding
// it provokes and which exit code the doctor must produce. This test runs the
// real core rule engine (`runDoctor` + `doctorExitCode`) against the checked-in
// manifests of each workspace and asserts the claim. The expectation table
// lives in ./expectations.ts (single source of truth, shared with the
// spawned-bin CLI tests); the fixtures/README.md and per-workspace READMEs
// mirror it (a string check at the bottom keeps them honest).
//
// The spawned CLI tests (`tests/cli/`) reproduce the same table through the
// real `dist/cli.js` process; this file keeps proving the pure-core half.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isParsedFederationManifest,
  runDoctor,
  validateFederationConfig,
  doctorExitCode,
  type DoctorRemoteInput,
  type FederationConfig,
  type FederationManifestSchema,
  type ParsedFederationManifest,
} from '../../src/core/index.js';
import { createNodeProjectFs } from '../../src/adapters/project-fs.js';
import { createFileManifestSource } from '../../src/adapters/manifest-source.js';
import { validateIntrospectionFacts } from '../../src/core/introspection-types.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures'
);

// The expectation table lives in ./expectations.ts (shared with the spawned
// CLI tests); this file only consumes it.

import { EXPECTATIONS } from './expectations.js';

// --------------------------------------------------------------------------
// Loading helpers (adapters, exactly what T7's CLI will compose).
// --------------------------------------------------------------------------

const fs = createNodeProjectFs();
const manifestSource = createFileManifestSource(fs);

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as unknown;
}

/** Load a workspace through its repack-federation.json, like the CLI will. */
async function loadWorkspace(dir: string): Promise<{
  config: FederationConfig;
  host: ParsedFederationManifest;
  remotes: DoctorRemoteInput[];
}> {
  const workspaceDir = path.join(fixturesDir, dir);
  const configPath = path.join(workspaceDir, 'repack-federation.json');
  const configDocument = await readJson(configPath);
  assert.deepEqual(
    validateFederationConfig(configDocument),
    [],
    `${dir}: repack-federation.json must pass core validation`
  );
  const config = configDocument as FederationConfig;

  const hostPath = path.resolve(workspaceDir, config.host.manifest);
  const hostResult = await manifestSource.load(hostPath);
  assert.equal(
    hostResult.status,
    'ok',
    `${dir}: host manifest must load cleanly`
  );

  const remotes: DoctorRemoteInput[] = [];
  for (const [name, remote] of Object.entries(config.remotes)) {
    const result = await manifestSource.load(
      path.resolve(workspaceDir, remote.manifest)
    );
    if (result.status === 'ok') {
      remotes.push({ name, manifest: result.manifest });
    } else if (result.failure === 'corrupt') {
      remotes.push({ name, corrupt: true, reason: result.message });
    } else {
      remotes.push({ name, missing: true });
    }
  }
  return { config, host: hostResult.manifest, remotes };
}

// --------------------------------------------------------------------------
// 1. Every manifest parses and structurally satisfies the core v1 schema.
// --------------------------------------------------------------------------

function assertSchemaV1(document: unknown, label: string): void {
  assert.ok(
    isParsedFederationManifest(document),
    `${label}: fails the minimal untrusted-input check`
  );
  const m = document as FederationManifestSchema;
  assert.equal(m.manifestVersion, 1, `${label}: manifestVersion`);
  assert.equal(typeof m.id, 'string', `${label}: id`);
  assert.equal(typeof m.name, 'string', `${label}: name`);

  assert.equal(typeof m.metaData?.globalName, 'string', `${label}: metaData`);
  assert.ok(
    m.metaData.type === 'host' || m.metaData.type === 'remote',
    `${label}: metaData.type`
  );
  assert.equal(
    typeof m.metaData.buildInfo?.buildVersion,
    'string',
    `${label}: metaData.buildInfo`
  );

  for (const entry of m.shared) {
    assert.equal(typeof entry.name, 'string', `${label}: shared.name`);
    assert.equal(typeof entry.version, 'string', `${label}: shared.version`);
    assert.equal(
      typeof entry.requiredVersion,
      'string',
      `${label}: shared.requiredVersion`
    );
    assert.equal(typeof entry.singleton, 'boolean', `${label}: shared.singleton`);
    assert.equal(typeof entry.eager, 'boolean', `${label}: shared.eager`);
  }
  for (const entry of m.remotes) {
    for (const key of [
      'federationContainerName',
      'moduleName',
      'alias',
      'entry',
    ] as const) {
      assert.equal(
        typeof entry[key],
        'string',
        `${label}: remotes.${key}`
      );
    }
  }
  for (const entry of m.exposes) {
    for (const key of ['id', 'name', 'path'] as const) {
      assert.equal(typeof entry[key], 'string', `${label}: exposes.${key}`);
    }
  }

  const native = m.reactNative;
  assert.equal(typeof native?.version, 'string', `${label}: reactNative.version`);
  assert.ok(Array.isArray(native.platforms), `${label}: reactNative.platforms`);
  assert.equal(
    typeof native.dynamicImportDetected,
    'boolean',
    `${label}: reactNative.dynamicImportDetected`
  );
  for (const module of native.nativeModules) {
    assert.equal(typeof module.package, 'string', `${label}: native.package`);
    assert.equal(typeof module.version, 'string', `${label}: native.version`);
    assert.equal(
      module.confidence === 'static' || module.confidence === 'heuristic',
      true,
      `${label}: native.confidence`
    );
    assert.equal(
      typeof module.turboModule,
      'boolean',
      `${label}: native.turboModule`
    );
  }
}

describe('fixture manifests satisfy the core schema', () => {
  for (const expectation of EXPECTATIONS) {
    it(`${expectation.dir}: every manifest is schema-faithful v1`, async () => {
      const manifestDir = path.join(fixturesDir, expectation.dir, 'manifests');
      const names = await fs.readdir(manifestDir);
      assert.deepEqual(
        [...names].sort(),
        expectation.missingManifest
          ? // The variant deletes one remote manifest: exactly two remain.
            ['host.json', 'mini-auth.json']
          : ['host.json', 'mini-auth.json', 'mini-store.json'],
        `${expectation.dir}: manifests/ content`
      );
      for (const name of names) {
        const label = `${expectation.dir}/manifests/${name}`;
        if (expectation.corrupt && name === 'mini-store.json') {
          // The MANIFEST_UNREADABLE provoker must stay unparseable —
          // otherwise the variant silently starts claiming an answer again.
          const raw = await readFile(path.join(manifestDir, name), 'utf-8');
          assert.throws(
            () => JSON.parse(raw),
            `${label}: must remain invalid JSON`
          );
          continue;
        }
        assertSchemaV1(await readJson(path.join(manifestDir, name)), label);
      }
    });
  }
});

// --------------------------------------------------------------------------
// 2. runDoctor + doctorExitCode reproduce each README claim.
// --------------------------------------------------------------------------

describe('fixture workspaces reproduce their expectation table', () => {
  for (const expectation of EXPECTATIONS) {
    it(`${expectation.dir}: exit ${expectation.exitCode}, findings [${expectation.findings
      .map((f) => f.code)
      .join(', ')}]`, async () => {
      const { host, remotes } = await loadWorkspace(expectation.dir);
      const report = runDoctor({ host, remotes });
      assert.equal(
        doctorExitCode(report),
        expectation.exitCode,
        `${expectation.dir}: exit code (findings: ${JSON.stringify(report.findings)})`
      );
      if (expectation.allowMissingExit !== undefined) {
        const lenient = runDoctor({ host, remotes, allowMissingManifests: true });
        assert.equal(
          doctorExitCode(lenient),
          expectation.allowMissingExit,
          `${expectation.dir}: exit code with --allow-missing-manifests`
        );
      }
      if (expectation.failOnWarningsExit !== undefined) {
        assert.equal(
          doctorExitCode(report, { failOnWarnings: true }),
          expectation.failOnWarningsExit,
          `${expectation.dir}: exit code with --fail-on-warnings`
        );
      }
      assert.deepEqual(
        report.findings
          .map((f) => ({
            code: f.code,
            severity: f.severity,
            confidence: f.confidence,
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        expectation.findings
          .map(({ code, severity, confidence }) => ({
            code,
            severity,
            confidence,
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        `${expectation.dir}: finding set`
      );
      for (const expected of expectation.findings) {
        if (!expected.app) continue;
        const finding = report.findings.find((f) => f.code === expected.code);
        assert.ok(
          finding?.message.includes(`"${expected.app}"`),
          `${expectation.dir}: ${expected.code} must name "${expected.app}"`
        );
      }
    });
  }
});

// --------------------------------------------------------------------------
// 3. Each app's rspack.config.js parses as ESM and registers both plugins
//    with facts consistent with its manifest — so T7/T9 spawns do not drown
//    in avoidable config errors. The two Atlas plugin imports are rewritten
//    to `data:` stubs (record their constructor options on globalThis), so
//    the check needs neither dist/, nor rspack, nor an install.
// --------------------------------------------------------------------------

const PLUGIN_IMPORTS = {
  plugin: '../../../../dist/repack-bridge/plugin.js',
  introspection: '../../../../dist/repack-bridge/introspection-plugin.js',
} as const;

function stubModuleUrl(className: string, kind: string): string {
  const source =
    `export class ${className} {\n` +
    '  constructor(options) {\n' +
    '    (globalThis.__atlasFixturePlugins ??= []).push(' +
    `{ kind: '${kind}', options });\n` +
    '  }\n' +
    '  apply() {}\n' +
    '}\n';
  return `data:text/javascript;base64,${Buffer.from(source, 'utf-8').toString('base64')}`;
}

/** App dir → manifest file → federation container name. */
const APPS = [
  { dir: 'host', manifest: 'host.json', name: 'host' },
  { dir: 'mini-auth', manifest: 'mini-auth.json', name: 'mini_auth' },
  { dir: 'mini-store', manifest: 'mini-store.json', name: 'mini_store' },
] as const;

const tmpRoots: string[] = [];
after(async () => {
  await Promise.all(
    tmpRoots.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function evaluateFixtureConfig(
  configPath: string
): Promise<Record<string, unknown>[]> {
  const source = await readFile(configPath, 'utf-8');
  const rewritten = source
    .replace(PLUGIN_IMPORTS.plugin, stubModuleUrl('FederationManifestPlugin', 'manifest'))
    .replace(
      PLUGIN_IMPORTS.introspection,
      stubModuleUrl('IntrospectionPlugin', 'introspection')
    );
  assert.notEqual(rewritten, source, `${configPath}: plugin imports not found`);
  assert.ok(
    rewritten.includes('FederationManifestPlugin'),
    `${configPath}: must reference FederationManifestPlugin`
  );
  assert.ok(
    rewritten.includes('IntrospectionPlugin'),
    `${configPath}: must reference IntrospectionPlugin`
  );

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'atlas-fixture-config-'));
  tmpRoots.push(tmpDir);
  const tmpFile = path.join(tmpDir, 'rspack.config.mjs');
  await writeFile(tmpFile, rewritten, 'utf-8');

  (globalThis as { __atlasFixturePlugins?: unknown[] }).__atlasFixturePlugins =
    [];
  await import(`file://${tmpFile}`); // ESM parse + evaluation of the config
  return (
    (globalThis as { __atlasFixturePlugins?: Record<string, unknown>[] })
      .__atlasFixturePlugins ?? []
  );
}

describe('fixture rspack configs are valid ESM registering both plugins', () => {
  for (const expectation of EXPECTATIONS) {
    for (const app of APPS) {
      it(`${expectation.dir}/apps/${app.dir}: config matches its manifest`, async () => {
        const workspaceDir = path.join(fixturesDir, expectation.dir);
        const plugins = await evaluateFixtureConfig(
          path.join(workspaceDir, 'apps', app.dir, 'rspack.config.js')
        );
        assert.deepEqual(
          plugins.map((p) => p.kind).sort(),
          ['introspection', 'manifest'],
          'exactly one of each Atlas plugin'
        );

        // The corrupt variant only corrupts the store manifest, never a
        // config: that app still must parse and register both plugins, but
        // there is no manifest to cross-check keys against. The
        // missing-manifest variant deleted the file outright — same reason
        // to skip the cross-check for that app.
        const manifestComparable = !(
          (expectation.corrupt || expectation.missingManifest) &&
          app.manifest === 'mini-store.json'
        );
        const manifest = manifestComparable
          ? ((await readJson(
              path.join(workspaceDir, 'manifests', app.manifest)
            )) as FederationManifestSchema)
          : null;

        const federation = plugins.find(
          (p) => p.kind === 'manifest'
        )!.options as {
          name: string;
          manifest: boolean;
          exposes: Record<string, string>;
          remotes: Record<string, string>;
        };
        assert.equal(federation.name, app.name, 'federation name');
        assert.equal(federation.manifest, true, 'manifest: true');
        if (manifest) {
          assert.deepEqual(
            Object.keys(federation.exposes).sort(),
            manifest.exposes.map((e) => `./${e.name}`).sort(),
            'exposes keys match the manifest'
          );
          assert.deepEqual(
            Object.keys(federation.remotes).sort(),
            manifest.remotes.map((r) => r.alias).sort(),
            'remotes keys match the manifest'
          );
        }

        const declared = plugins.find(
          (p) => p.kind === 'introspection'
        )!.options as Record<string, unknown>;
        // The real plugin adds `schemaVersion` when it serializes the facts
        // document; validate the same shape here.
        assert.deepEqual(
          validateIntrospectionFacts({ schemaVersion: 1, ...declared }),
          [],
          'introspection facts pass core validation'
        );
        assert.equal(declared.name, app.name, 'introspection name');
        if (app.dir !== 'host') {
          const config = await loadWorkspace(expectation.dir);
          const remoteEntry =
            config.config.remotes[app.name];
          assert.equal(
            declared.port,
            remoteEntry?.port,
            'declared dev port matches repack-federation.json'
          );
        }
      });
    }
  }
});

// --------------------------------------------------------------------------
// 4. READMEs mirror the expectation table (kept honest, cheaply).
// --------------------------------------------------------------------------

describe('fixture READMEs mirror the expectation table', () => {
  for (const expectation of EXPECTATIONS) {
    it(`${expectation.dir}: README states its codes and exit code`, async () => {
      const readme = await readFile(
        path.join(fixturesDir, expectation.dir, 'README.md'),
        'utf-8'
      );
      for (const finding of expectation.findings) {
        assert.ok(
          readme.includes(finding.code),
          `${expectation.dir}/README.md must mention ${finding.code}`
        );
      }
      assert.ok(
        readme.includes(`**${expectation.exitCode}**`),
        `${expectation.dir}/README.md must state exit code ${expectation.exitCode}`
      );
    });
  }
});
