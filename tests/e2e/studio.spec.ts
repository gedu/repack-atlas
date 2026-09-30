// End-to-end tests for the Federation Studio page.
//
// Scope: what only a browser can prove — the graph renders, clicking a node
// updates the inspector, cycle edges are dashed, findings appear, and hostile
// manifest strings render as TEXT. The cheap static equivalents (no innerHTML,
// no external loads) live in tests/studio/page.test.ts; this file is the
// behavioral proof behind AGENTS.md rule 5.
//
// The default workspace comes from the `webServer` in playwright.config.ts
// (fixtures/workspace, fixed port). The cycle and rendering-probe workspaces
// need a different `--workspace`, so each test group spawns its own preview
// process on its own port — the same tool, different input.

import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const previewTool = path.join(repoRoot, 'tools', 'studio-preview.mjs');

interface Preview {
  url: string;
  stop: () => Promise<void>;
}

/** Boot `tools/studio-preview.mjs` for one workspace on a dedicated port. */
async function startPreview(workspace: string, port: number): Promise<Preview> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [previewTool, '--workspace', workspace, '--port', String(port)],
    { cwd: repoRoot, stdio: 'pipe' }
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/graph`);
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`preview for ${workspace} did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    url,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}

/** Collect dialogs so an XSS probe either shows up here or never happened. */
function watchDialogs(page: Page): string[] {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
}

const basePort = Number(process.env.ATLAS_STUDIO_PORT ?? 8099);

test.describe('Studio over the clean workspace fixture', () => {
  test('renders the app pills, the graph and an empty findings list', async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto('/');

    await expect(page.locator('#sessions .sess')).toHaveCount(3);
    await expect(page.locator('#sessions .sess').first()).toContainText('host');
    await expect(page.locator('#sessions .sess').first()).toContainText('idle');

    // One node per app: host + two mini-apps.
    await expect(page.locator('svg.graph g.node')).toHaveCount(3);
    await expect(page.locator('svg.graph g.node[data-node="mini_auth"]')).toHaveCount(1);
    await expect(page.locator('svg.graph path.edge')).toHaveCount(2);

    // No cycle edges in the clean workspace, and no findings.
    await expect(page.locator('svg.graph path.edge.cycle')).toHaveCount(0);
    await expect(page.locator('#issues .issue')).toHaveCount(0);
    await expect(page.locator('#issue-count')).toContainText('0 errors');

    expect(dialogs).toEqual([]);
  });

  test('clicking a node updates the inspector, tabs switch sections', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#insp-name')).toHaveText('host');

    await page.locator('svg.graph g.node[data-node="mini_auth"]').click();
    await expect(page.locator('#insp-name')).toHaveText('mini_auth');
    await expect(page.locator('#insp-meta')).toContainText('REMOTE');
    await expect(page.locator('#insp-meta')).toContainText(':8082');

    // Exposes tab lists the exposed module and the copy affordance.
    await expect(page.locator('#tab-body .exp-name')).toContainText('./Login');
    await expect(page.locator('#tab-body button.btn')).toHaveText('Copy snippet');
    // Honest granularity note: consumed by host, but not provable per module.
    await expect(page.locator('#tab-body .used-by')).toContainText('host loads this container');

    await page.locator('.tab[data-tab="shared"]').click();
    await expect(page.locator('#tab-body table.kv td').first()).toHaveText('react');

    // mini_auth declares no native modules: the honest empty state, not a
    // borrowed table from another app.
    await page.locator('.tab[data-tab="native"]').click();
    await expect(page.locator('#tab-body')).toContainText('No native module was detected');

    // Selecting another node swaps every section's data.
    await page.locator('svg.graph g.node[data-node="mini_store"]').click();
    await expect(page.locator('#insp-name')).toHaveText('mini_store');
    await expect(page.locator('#tab-body table.kv')).toContainText('react-native-reanimated');

    await page.locator('.tab[data-tab="bundle"]').click();
    await expect(page.locator('#tab-body')).toContainText('No bundle data available');
  });

  test('the copy-snippet button copies the exact exposes line', async ({ page, context }) => {
    // The Clipboard API needs the permission and a secure context; 127.0.0.1
    // qualifies as secure, the permission grant covers headless defaults.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await page.locator('svg.graph g.node[data-node="mini_auth"]').click();
    await page.locator('#tab-body button.btn').first().click();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "'./Login': './src/Login',"
    );
    await expect(page.locator('#toast')).toContainText('Paste it into exposes');
  });

  test('graph nodes are keyboard-operable', async ({ page }) => {
    await page.goto('/');
    await page.locator('svg.graph g.node[data-node="mini_store"]').press('Enter');
    await expect(page.locator('#insp-name')).toHaveText('mini_store');
  });

  test('the page has no horizontal scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/');
    await expect(page.locator('svg.graph g.node')).toHaveCount(3);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Studio over the remote-cycle fixture', () => {
  let preview: Preview;

  test.beforeAll(async () => {
    preview = await startPreview(path.join(repoRoot, 'fixtures', 'fixture-remote-cycle'), basePort + 11);
  });
  test.afterAll(async () => {
    await preview?.stop();
  });

  test('draws cycle edges dashed and lists the REMOTE_CYCLE finding', async ({ page }) => {
    await page.goto(preview.url);

    await expect(page.locator('svg.graph path.edge.cycle')).toHaveCount(2);
    await expect(page.locator('svg.graph g.node[data-node="mini_auth"]')).toHaveCount(1);
    // Warning badge on both apps of the cycle.
    await expect(page.locator('svg.graph g.node[data-node="mini_auth"] circle.badge-w')).toHaveCount(1);

    const finding = page.locator('#issues .issue[data-code="REMOTE_CYCLE"]');
    await expect(finding).toHaveCount(1);
    await expect(finding).toContainText('REMOTE_CYCLE');
    await expect(finding.locator('.msg')).toContainText('mini_auth -> mini_store');
    await expect(finding.locator('.stripe')).toHaveClass(/stripe/);
    // Warning, not error: the stripe must not be the error variant.
    await expect(finding.locator('.stripe.bad')).toHaveCount(0);
    await expect(page.locator('#issue-count')).toContainText('0 errors');
    await expect(page.locator('#issue-count')).toContainText('1 warnings');
  });
});

test.describe('Studio over the rendering probe fixture', () => {
  let preview: Preview;

  test.beforeAll(async () => {
    preview = await startPreview(path.join(repoRoot, 'fixtures', 'fixture-xss'), basePort + 23);
  });
  test.afterAll(async () => {
    await preview?.stop();
  });

  test('renders hostile manifest strings as text and injects nothing', async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto(preview.url);

    await expect(page.locator('svg.graph g.node')).toHaveCount(3);
    // An app NAME that is markup: it must land as literal text in the graph.
    const hostileHost = 'host<img src=x onerror=alert(6)>';
    await expect(
      page.locator(`svg.graph g.node[aria-label^="${hostileHost}"]`)
    ).toHaveCount(1);
    await expect(page.locator('#sessions .sess').first()).toContainText('onerror=alert(6)');
    await expect(page.locator('#insp-name')).toHaveText(hostileHost);

    // Expose NAME/PATH probes: literal text in the inspector list.
    await page.locator('.sess').filter({ hasText: 'mini_store' }).click();
    await expect(page.locator('#tab-body .exp-name')).toContainText('<script>alert(1)</script>');
    await expect(page.locator('#tab-body .path')).toContainText('<img src=x onerror=alert(2)>');
    // Text, not markup: the literal probe string is readable in the page.
    expect(await page.locator('#tab-body').innerText()).toContain('<script>alert(1)</script>');

    // Shared probe lives in mini_store's shared list.
    await page.locator('.tab[data-tab="shared"]').click();
    await expect(page.locator('#tab-body table.kv')).toContainText('<svg onload=alert(3)>');

    // The native probe lives in the HOST manifest's nativeModules.
    await page.locator('.sess').filter({ hasText: 'onerror=alert(6)' }).click();
    await page.locator('.tab[data-tab="native"]').click();
    await expect(page.locator('#tab-body table.kv')).toContainText('<script>alert(4)</script>');

    // Nothing was parsed into an element, anywhere: the probes only ever
    // appear as text, never as img/svg/script nodes or event attributes.
    await expect(page.locator('body > img, #tab-body img, .issues img')).toHaveCount(0);
    expect(await page.locator('[onerror]').count()).toBe(0);
    expect(await page.locator('[onload]').count()).toBe(0);
    // Only the page's own inline script exists: no script was injected.
    expect(await page.locator('script').count()).toBe(1);
    // A manifest probe must never reach alert(): no dialog was observed.
    expect(dialogs).toEqual([]);
  });
});

/**
 * Minimal workspace with the shape that used to draw badly: a host on the
 * left and three remotes stacked in one column (auth, trading, wallet), with
 * host -> each remote plus trading -> auth and wallet -> auth (the last one
 * spans the trading node). The wallet declares a heuristic native module.
 */
async function writeStackedWorkspace(dir: string): Promise<void> {
  const remoteNames = ['auth', 'trading', 'wallet'];
  const entry = (name: string, port: number) => ({
    federationContainerName: name,
    moduleName: name,
    alias: name,
    entry: `http://127.0.0.1:${port}/${name}.container.js`,
  });
  const manifest = (
    name: string,
    type: 'host' | 'remote',
    remotes: string[],
    nativeModules: object[]
  ) => ({
    manifestVersion: 1,
    id: name,
    name,
    metaData: {
      name,
      globalName: name,
      type,
      buildInfo: { buildVersion: 'e2e', buildName: name },
      ...(type === 'remote'
        ? { remoteEntry: { name: `${name}.container.js`, path: '', type: 'var' } }
        : {}),
      publicPath: 'auto',
    },
    shared: [],
    remotes: remotes.map((remote) => entry(remote, 9000 + remoteNames.indexOf(remote))),
    exposes: [],
    reactNative: { version: '0.79.2', platforms: ['ios'], nativeModules, dynamicImportDetected: false },
  });
  const native = (confidence: string) => [
    { package: 'react-native-mmkv', version: '3.0.0', turboModule: true, confidence },
  ];
  const manifests: Record<string, object> = {
    host: manifest('host', 'host', remoteNames, []),
    auth: manifest('auth', 'remote', [], []),
    trading: manifest('trading', 'remote', ['auth'], []),
    wallet: manifest('wallet', 'remote', ['auth'], native('heuristic')),
  };
  await mkdir(path.join(dir, 'manifests'), { recursive: true });
  for (const [name, content] of Object.entries(manifests)) {
    await writeFile(path.join(dir, 'manifests', `${name}.json`), JSON.stringify(content));
  }
  const config = {
    host: { manifest: './manifests/host.json' },
    remotes: Object.fromEntries(
      remoteNames.map((name, index) => [
        name,
        { manifest: `./manifests/${name}.json`, port: 9100 + index },
      ])
    ),
  };
  await writeFile(path.join(dir, 'repack-federation.json'), JSON.stringify(config));
}

test.describe('Studio over a stacked one-column workspace', () => {
  let preview: Preview;
  let workspace: string;

  test.beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'atlas-stacked-'));
    await writeStackedWorkspace(workspace);
    preview = await startPreview(workspace, basePort + 37);
  });
  test.afterAll(async () => {
    await preview?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  test('same-column edges route around the nodes between their ends', async ({ page }) => {
    await page.goto(preview.url);
    await expect(page.locator('svg.graph g.node')).toHaveCount(4);
    await expect(page.locator('svg.graph path.edge')).toHaveCount(5);

    const boxOf = (selector: string) =>
      page.locator(selector).evaluate((node) => {
        const box = (node as SVGGraphicsElement).getBBox();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      });
    const nodeBoxes: Record<string, Box> = {};
    for (const name of ['host', 'auth', 'trading', 'wallet']) {
      nodeBoxes[name] = await boxOf(`svg.graph g.node[data-node="${name}"] rect.box`);
    }

    // wallet -> auth spans the trading node: its curve must bow out to the
    // right of the column instead of crossing the trading rectangle.
    const points = await page
      .locator('svg.graph path.edge[data-edge="wallet->auth"]')
      .evaluate((node) => {
        const path = node as unknown as SVGGeometryElement;
        const total = path.getTotalLength();
        return Array.from({ length: 41 }, (_, step) => {
          const point = path.getPointAtLength((total * step) / 40);
          return { x: point.x, y: point.y };
        });
      });
    const trading = nodeBoxes['trading']!;
    for (const point of points) {
      const inside =
        point.x > trading.x && point.x < trading.x + trading.width &&
        point.y > trading.y && point.y < trading.y + trading.height;
      expect(inside, `wallet->auth passes through trading at ${point.x},${point.y}`).toBe(false);
    }
    // The end of the edge sits at the auth node and points at it (right side).
    const last = points[points.length - 1]!;
    const auth = nodeBoxes['auth']!;
    expect(Math.abs(last.x - (auth.x + auth.width))).toBeLessThan(10);
    expect(last.y).toBeGreaterThan(auth.y);
    expect(last.y).toBeLessThan(auth.y + auth.height);

  });
});
