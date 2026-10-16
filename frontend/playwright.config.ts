import { defineConfig, devices } from '@playwright/test';

// The stack's ports default to the ones `make dev-fake-poc` documents. Set them when
// another process already holds a default (for example a PoC on :8080); CI keeps the defaults.
const port = process.env.E2E_FRONTEND_PORT ?? '9000';
const bffPort = process.env.E2E_BFF_PORT ?? '8080';
const backendPort = process.env.E2E_BACKEND_PORT ?? '9090';
const hubPort = process.env.E2E_HUB_PORT ?? '9091';
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // The PoC preset (mock/fixtures-poc): the specs use the PoC's site, model and pin names.
    command: 'make -C .. dev-fake-poc',
    // Vite answers before the BFF and the fake do, so wait on an API path that only they serve.
    url: `${origin}/api/v1/clusters`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      FRONTEND_PORT: port,
      PORT: bffPort,
      BFF_URL: `http://127.0.0.1:${bffPort}`,
      BACKEND_ADDRESS: `127.0.0.1:${backendPort}`,
      FAKE_HUB_ADDRESS: `127.0.0.1:${hubPort}`,
    },
  },
});
