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

/** Open the Doctor top-level tab (the findings table lives there). */
async function openDoctorTab(page: Page): Promise<void> {
  await page.locator('#view-tabs .view-tab[data-view="doctor"]').click();
  await expect(page.locator('#view-doctor')).toBeVisible();
}

/** The default Apps view: the selected app's panel must be visible. */
async function expectAppsTab(page: Page): Promise<void> {
  await expect(page.locator('#view-tab-apps')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#view-apps')).toBeVisible();
  await expect(page.locator('#view-doctor')).toBeHidden();
}

const basePort = Number(process.env.ATLAS_STUDIO_PORT ?? 8099);

test.describe('Studio over the clean workspace fixture', () => {
  test('renders the app pills, the graph and an empty findings list', async ({ page }) => {
    const dialogs = watchDialogs(page);
    await page.goto('/');
    await expectAppsTab(page);
    await openDoctorTab(page);

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

  test('the per-app panel shows the honest hint when nothing mentions the app', async ({ page }) => {
    // The clean workspace has no findings at all, so every app lands on the
    // empty state instead of a borrowed global list.
    await page.goto('/');
    await expectAppsTab(page);
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · host (0)');
    await expect(page.locator('#app-issues li.hint')).toHaveText('No findings mention host.');

    await page.locator('svg.graph g.node[data-node="mini_auth"]').click();
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · mini_auth (0)');
    await expect(page.locator('#app-issues li.hint')).toHaveText('No findings mention mini_auth.');
    await expect(page.locator('#app-issues .issue')).toHaveCount(0);
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
    await openDoctorTab(page);

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

  test('badge aria-label and tooltip read as findings that mention the app', async ({ page }) => {
    await page.goto(preview.url);

    // The badge counts findings whose MESSAGE mentions the app, and the
    // accessible name now says so instead of implying ownership.
    const label = await page
      .locator('svg.graph g.node[data-node="mini_auth"]')
      .getAttribute('aria-label');
    expect(label).toContain('1 findings mention mini_auth');
    await expect(
      page.locator('svg.graph g.node[data-node="mini_auth"] title')
    ).toHaveText('1 findings mention mini_auth');
  });

  test('Apps panel lists the warning that mentions the app and hides nothing', async ({ page }) => {
    await page.goto(preview.url);
    // Warning (not info) findings ARE listed here, and the header count is
    // exactly the badge count: one REMOTE_CYCLE warning mentions mini_auth.
    await page.locator('svg.graph g.node[data-node="mini_auth"]').click();
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · mini_auth (1)');
    await expect(page.locator('#app-issues .issue[data-code="REMOTE_CYCLE"]')).toHaveCount(1);
    await expect(page.locator('#app-issues li.hint')).toHaveCount(0);

    // The cycle message never names the host: the host gets the honest hint,
    // not an empty panel or the other apps' findings.
    await page.locator('svg.graph g.node[data-node="host"]').click();
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · host (0)');
    await expect(page.locator('#app-issues li.hint')).toHaveText('No findings mention host.');
  });

  test('severity chips show the warning by default and hide it on click', async ({ page }) => {
    await page.goto(preview.url);
    await openDoctorTab(page);

    const errors = page.locator('#issue-chips .chip[data-severity="errors"]');
    const warnings = page.locator('#issue-chips .chip[data-severity="warnings"]');
    const infos = page.locator('#issue-chips .chip[data-severity="infos"]');
    await expect(page.locator('#issue-chips .chip')).toHaveCount(3);
    // errors + warnings on, infos off, counts always the totals.
    await expect(errors).toHaveText('errors (0)');
    await expect(errors).toHaveAttribute('aria-pressed', 'true');
    await expect(warnings).toHaveText('warnings (1)');
    await expect(warnings).toHaveAttribute('aria-pressed', 'true');
    await expect(infos).toHaveText('infos (0)');
    await expect(infos).toHaveAttribute('aria-pressed', 'false');

    // Turning warnings off removes the row but never changes the summary.
    await warnings.click();
    await expect(page.locator('#issues .issue')).toHaveCount(0);
    await expect(warnings).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#issue-count')).toContainText('1 warnings');

    // And back on: the same single row.
    await warnings.click();
    await expect(page.locator('#issues .issue[data-code="REMOTE_CYCLE"]')).toHaveCount(1);
  });
});

test.describe('Studio over the eager-advisory fixture (info findings)', () => {
  let preview: Preview;

  test.beforeAll(async () => {
    preview = await startPreview(path.join(repoRoot, 'fixtures', 'fixture-eager-advisory'), basePort + 53);
  });
  test.afterAll(async () => {
    await preview?.stop();
  });

  test('hides infos by default and collapses repeated codes behind a count', async ({ page }) => {
    await page.goto(preview.url);
    await openDoctorTab(page);

    // Four info findings exist but are NOT in the default view: the hint
    // explains why (same signal-to-noise rule the CLI panel uses).
    await expect(page.locator('#issues .issue')).toHaveCount(0);
    await expect(page.locator('#issues li.hint')).toContainText(
      'infos are hidden \u2014 enable the infos chip to show them'
    );
    // The summary still counts every finding by severity.
    await expect(page.locator('#issue-count')).toContainText('4 infos');
    await expect(page.locator('#issue-chips .chip[data-severity="infos"]')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    // Infos must not paint every node: graph badges stay error/warning only.
    await expect(page.locator('svg.graph circle.badge-c, svg.graph circle.badge-w')).toHaveCount(0);

    await page.locator('#issue-chips .chip[data-severity="infos"]').click();
    await expect(page.locator('#issue-chips .chip[data-severity="infos"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // One group per finding code: first row shown, the rest behind the count.
    await expect(page.locator('#issues .issue[data-code="EAGER_ADVISORY"]')).toHaveCount(1);
    const more = page.locator('#issues .issue-more[data-code="EAGER_ADVISORY"]');
    await expect(more).toHaveCount(1);
    await expect(more).toHaveText('+ 3 more EAGER_ADVISORY \u2014 click to expand all');
    await expect(more).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#issues li.hint')).toHaveCount(0);

    await more.click();
    await expect(page.locator('#issues .issue[data-code="EAGER_ADVISORY"]')).toHaveCount(4);

    // Collapse again returns to the one-row group.
    await more.click();
    await expect(page.locator('#issues .issue[data-code="EAGER_ADVISORY"]')).toHaveCount(1);

    // Turning infos off goes back to the hint, and the summary never moved.
    await page.locator('#issue-chips .chip[data-severity="infos"]').click();
    await expect(page.locator('#issues .issue')).toHaveCount(0);
    await expect(page.locator('#issue-count')).toContainText('4 infos');
  });

  test('an expanded info row still selects the app it mentions', async ({ page }) => {
    await page.goto(preview.url);
    await openDoctorTab(page);
    await page.locator('#issue-chips .chip[data-severity="infos"]').click();
    await page.locator('#issues .issue-more[data-code="EAGER_ADVISORY"]').click();

    // Existing row-click contract: the first app name occurring in the
    // message is selected (every eager advisory mentions "host" first), and
    // the jump now also lands back on the Apps tab.
    await page.locator('#issues .issue[data-code="EAGER_ADVISORY"]').nth(2).click();
    await expect(page.locator('#insp-name')).toHaveText('host');
    await expectAppsTab(page);
  });

  test('default view is Apps: doctor table hidden, per-app panel visible', async ({ page }) => {
    await page.goto(preview.url);
    await expectAppsTab(page);
    await expect(page.locator('#app-findings')).toBeVisible();
    await expect(page.locator('#view-tab-doctor')).toHaveAttribute('aria-selected', 'false');
    // Host is selected by default. Every advisory is an info, and the panel
    // lists the badge set (error + warning) only, so nothing is listed and
    // the header count matches the (absent) badge instead of 4.
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · host (0)');
    await expect(page.locator('#app-issues .issue')).toHaveCount(0);
    await expect(page.locator('#app-issues li.hint')).toHaveText(
      '4 info findings hidden \u2014 the Doctor tab lists them.'
    );
  });

  test('Apps panel lists only the findings that mention the selected app', async ({ page }) => {
    await page.goto(preview.url);
    await expectAppsTab(page);

    // Host selected by default: 4 mentioning findings, all infos -> none
    // listed (the Doctor tab owns them) and the hint says how many.
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · host (0)');
    await expect(page.locator('#app-issues li.hint')).toHaveText(
      '4 info findings hidden \u2014 the Doctor tab lists them.'
    );

    // Selecting a remote narrows the hint to THAT app's mentions, and the
    // panel stays honest: mini_auth is mentioned by 2 infos, listed by none.
    await page.locator('svg.graph g.node[data-node="mini_auth"]').click();
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · mini_auth (0)');
    await expect(page.locator('#app-issues .issue')).toHaveCount(0);
    await expect(page.locator('#app-issues li.hint')).toHaveText(
      '2 info findings hidden \u2014 the Doctor tab lists them.'
    );
    // Infos must not paint badges either: the Apps panel and the badges agree
    // on the same error+warning set.
    await expect(page.locator('svg.graph circle.badge-c, svg.graph circle.badge-w')).toHaveCount(0);

    // The Doctor tab keeps the global view untouched by the selection.
    await openDoctorTab(page);
    await expect(page.locator('#issue-count')).toContainText('4 infos');
  });

  // An all-info app must never look silently empty, and the hint count must
  // match the payload; the warning-set listing is covered in the cycle
  // describe ('Apps panel lists the warning that mentions the app').
  test('per-app counts survive a Doctor tab round trip and match the payload', async ({ page }) => {
    await page.goto(preview.url);
    // Open the Doctor tab first and come back: the tab state must survive.
    await openDoctorTab(page);
    await page.locator('#view-tabs .view-tab[data-view="apps"]').click();
    await page.locator('.sess').filter({ hasText: 'mini_store' }).click();
    await expect(page.locator('#app-findings-title')).toHaveText('Findings · mini_store (0)');

    // Every finding in THIS fixture is an info, so mini_store lists nothing
    // and must explain itself instead of looking silently empty: assert the
    // count honestly against the payload the page rendered from.
    const findings = await page.evaluate(async () => {
      const response = await fetch('api/graph');
      const graph = (await response.json()) as {
        findings: { message: string; severity: string }[];
      };
      return graph.findings.filter(
        (f) => f.message.includes('mini_store') && f.severity === 'info'
      ).length;
    });
    await expect(page.locator('#app-issues li.hint')).toHaveText(
      `${findings} info findings hidden \u2014 the Doctor tab lists them.`
    );
    await expect(page.locator('#app-issues .issue')).toHaveCount(0);
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
async function writeStackedWorkspace(dir: string, standalone: string[] = []): Promise<void> {
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
    // Deliberately long: the nowrap test needs a version that would wrap.
    { package: 'react-native-mmkv', version: '7.21.11', turboModule: true, confidence },
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
        {
          manifest: `./manifests/${name}.json`,
          port: 9100 + index,
          ...(standalone.includes(name) ? { standalone: true } : {}),
        },
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
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  const boxesOverlap = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  const boxOf = (page: Page, selector: string): Promise<Box> =>
    page.locator(selector).evaluate((node) => {
      const box = (node as SVGGraphicsElement).getBBox();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  const nodeBoxesOf = async (page: Page): Promise<Record<string, Box>> => {
    const boxes: Record<string, Box> = {};
    for (const name of ['host', 'auth', 'trading', 'wallet']) {
      boxes[name] = await boxOf(page, `svg.graph g.node[data-node="${name}"] rect.box`);
    }
    return boxes;
  };
  const pathPoints = (page: Page, edge: string) =>
    page.locator(`svg.graph path.edge[data-edge="${edge}"]`).evaluate((node) => {
      const path = node as unknown as SVGGeometryElement;
      const total = path.getTotalLength();
      return Array.from({ length: 41 }, (_, step) => {
        const point = path.getPointAtLength((total * step) / 40);
        return { x: point.x, y: point.y };
      });
    });

  test('same-column edges route around the nodes between their ends', async ({ page }) => {
    await page.goto(preview.url);
    await expect(page.locator('svg.graph g.node')).toHaveCount(4);
    await expect(page.locator('svg.graph path.edge')).toHaveCount(5);
    const nodeBoxes = await nodeBoxesOf(page);

    // wallet -> auth spans the trading node: its curve must bow out to the
    // right of the column instead of crossing the trading rectangle.
    const points = await pathPoints(page, 'wallet->auth');
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

    // Overlapping same-column edges use distinct lanes: wallet -> auth bows
    // further out than trading -> auth and the two curves never coincide.
    const short = await pathPoints(page, 'trading->auth');
    const farthest = (list: { x: number }[]) => Math.max(...list.map((point) => point.x));
    expect(farthest(points)).toBeGreaterThan(farthest(short) + 10);
    const shared = points.filter((point) =>
      short.some((other) => Math.hypot(point.x - other.x, point.y - other.y) < 1)
    );
    expect(shared, 'the two same-column curves share points').toHaveLength(0);
  });

  test('rendered edge labels clear every node, sit in their background and the viewBox', async ({ page }) => {
    await page.goto(preview.url);
    await expect(page.locator('svg.graph g.node')).toHaveCount(4);
    const nodeBoxes = await nodeBoxesOf(page);
    // Measure the rendered glyphs, not the background rect sized from an estimate.
    const labels = await page.locator('svg.graph text.elabel').evaluateAll((texts) =>
      texts.map((text) => {
        const box = (text as SVGGraphicsElement).getBBox();
        const bg = (text.parentElement!.querySelector('rect.elabel-bg') as SVGGraphicsElement).getBBox();
        return {
          text: { x: box.x, y: box.y, width: box.width, height: box.height },
          bg: { x: bg.x, y: bg.y, width: bg.width, height: bg.height },
        };
      })
    );
    expect(labels).toHaveLength(5);
    const view = await page.locator('svg.graph').evaluate((node) => {
      const box = (node as unknown as SVGSVGElement).viewBox.baseVal;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    for (const { text, bg } of labels) {
      for (const [name, nodeBox] of Object.entries(nodeBoxes)) {
        expect(boxesOverlap(text, nodeBox), `a label overlaps node ${name}`).toBe(false);
      }
      expect(text.x).toBeGreaterThanOrEqual(bg.x);
      expect(text.y).toBeGreaterThanOrEqual(bg.y);
      expect(text.x + text.width).toBeLessThanOrEqual(bg.x + bg.width);
      expect(text.y + text.height).toBeLessThanOrEqual(bg.y + bg.height);
      expect(text.x).toBeGreaterThanOrEqual(view.x);
      expect(text.y).toBeGreaterThanOrEqual(view.y);
      expect(text.x + text.width).toBeLessThanOrEqual(view.x + view.width);
      expect(text.y + text.height).toBeLessThanOrEqual(view.y + view.height);
    }
  });

  test('confidence badges never wrap inside their pill', async ({ page }) => {
    await page.goto(preview.url);
    await page.locator('svg.graph g.node[data-node="wallet"]').click();
    await page.locator('.tab[data-tab="native"]').click();
    const badge = page.locator('#tab-body .pill', { hasText: 'heuristic' });
    await expect(badge).toHaveCount(1);
    const size = await badge.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return { lines: range.getClientRects().length, whiteSpace: getComputedStyle(node).whiteSpace };
    });
    expect(size.whiteSpace).toBe('nowrap');
    expect(size.lines).toBe(1);
  });

  test('long native module versions never wrap', async ({ page }) => {
    await page.goto(preview.url);
    await page.locator('svg.graph g.node[data-node="wallet"]').click();
    await page.locator('.tab[data-tab="native"]').click();
    const cell = page.locator('#tab-body table.kv td', { hasText: '7.21.11' });
    await expect(cell).toHaveCount(1);
    const size = await cell.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return { lines: range.getClientRects().length, whiteSpace: getComputedStyle(node).whiteSpace };
    });
    expect(size.whiteSpace).toBe('nowrap');
    expect(size.lines).toBe(1);
  });
});

test.describe('Studio over a workspace with a standalone-declaring remote', () => {
  let preview: Preview;
  let workspace: string;

  test.beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'atlas-standalone-'));
    await writeStackedWorkspace(workspace, ['auth']);
    preview = await startPreview(workspace, basePort + 41);
  });
  test.afterAll(async () => {
    await preview?.stop();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  test('shows a read-only standalone badge only on the declaring remote', async ({ page }) => {
    await page.goto(preview.url);
    await expect(page.locator('svg.graph g.node')).toHaveCount(4);

    const badge = page.locator('svg.graph g.node[data-node="auth"] text.tag-standalone-t');
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveText('standalone');
    await expect(page.locator('svg.graph text.tag-standalone-t')).toHaveCount(1);
    await expect(page.locator('svg.graph g.node[data-node="wallet"] .tag-standalone')).toHaveCount(0);

    // The pill sits left of the status dot without touching it.
    const node = page.locator('svg.graph g.node[data-node="auth"]');
    const pill = await node.locator('rect.tag-standalone').boundingBox();
    const dot = await node.locator('circle:not(.badge-c):not(.badge-w)').first().boundingBox();
    const label = await badge.boundingBox();
    expect(pill).not.toBeNull();
    expect(dot).not.toBeNull();
    expect(label).not.toBeNull();
    expect(pill!.x + pill!.width).toBeLessThanOrEqual(dot!.x);
    expect(label!.x + label!.width).toBeLessThanOrEqual(dot!.x);

    // The badge is not a control: no extra interactive element appears.
    await expect(page.locator('svg.graph g.node[data-node="auth"] [role="button"]')).toHaveCount(0);

    await page.locator('svg.graph g.node[data-node="auth"]').click();
    await expect(page.locator('#insp-meta')).toContainText('standalone');
    await page.locator('svg.graph g.node[data-node="wallet"]').click();
    await expect(page.locator('#insp-meta')).not.toContainText('standalone');
  });
});
