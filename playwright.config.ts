import { defineConfig } from '@playwright/test';

// Playwright drives the Studio through `tools/studio-preview.mjs`, the same
// entry a human uses. Fixed port so the URL is deterministic; the tool exits 2
// if the build output is missing, and `reuseExistingServer` lets a developer
// keep a preview running while iterating.
const PORT = Number(process.env.ATLAS_STUDIO_PORT ?? 8099);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node tools/studio-preview.mjs --workspace fixtures/workspace --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/graph`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  },
});
