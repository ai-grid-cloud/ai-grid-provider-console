import { defineConfig, devices } from '@playwright/test';

// The stack the specs run on: the backend at .backend-api-version on its own fake hub and Keycloak,
// PoC preset (hack/backend-fakes.sh), its BFF and the production bundle. Its ports differ from the
// ones `make dev-fake` uses, so a running `make dev-fake` (default preset, not the PoC's) is never
// taken for it. Set them when another process already holds one; CI keeps the
// defaults. The backend takes five ports from E2E_BACKEND_PORT up: gRPC and Connect, its fake
// hub, HTTP, Keycloak and the draft.
const port = process.env.E2E_FRONTEND_PORT ?? '9200';
const bffPort = process.env.E2E_BFF_PORT ?? '8280';
const backendPort = Number(process.env.E2E_BACKEND_PORT ?? '9290');
const origin = `http://127.0.0.1:${port}`;
const browser = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

export default defineConfig<object, { bffURL: string }>({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  // A test.only left in a commit would otherwise make CI run that one test and pass.
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: origin,
    colorScheme: 'light',
    trace: 'retain-on-failure',
    // Without these an action or a navigation that never completes uses up the whole test
    // timeout and is reported as a bare test timeout; with them the failure names the line.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    // One test at a time. The specs share one backend, whose Git catalog of models and
    // subscriptions it fetches on every read and writes under one lock, so a write queues behind
    // every other call on the catalog. A Models or Subscriptions write must be confirmed within the
    // form's short wait plus an assertion's, as a user sees it confirmed; run beside another spec's
    // catalog reads and writes, it queued behind them past both (the deploy flow failed so in CI).
    // Alone, each write takes the time the backend needs for it. Some specs change a fixture
    // cluster and put it back (cluster-membership adds site4 to AI grid and removes it;
    // cluster-edit edits site2's location label and sets site3's role; models gives site1 a role
    // for its run), so the fixture clusters the writers change are theirs for the run.
    // bffURL: each page comes from the stack's BFF, with the console's page headers (e2e/fixtures.ts).
    { name: 'backend fakes', use: { ...browser, bffURL: `http://127.0.0.1:${bffPort}` }, workers: 1 },
  ],
  // Playwright starts the three in parallel and fails the run at once if one exits before it
  // answers. Outside CI it reuses whatever already answers on the ports. Each page itself comes
  // from the BFF, with its Content-Security-Policy (e2e/fixtures.ts), so a BFF reused from
  // elsewhere must serve the bundle too (--static-assets-dir).
  webServer: [
    {
      // make dev-fake-backend on the PoC preset (the backend's fixtures/poc): the specs use the
      // PoC's site, model and organization names. The first run fetches the backend at the pin and
      // builds it, hence the long wait. A script rather than make: CI's Playwright image has none.
      command: '../hack/backend-fakes.sh',
      port: backendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
      env: {
        DEV_FIXTURES: 'fixtures/poc',
        DEV_DRAFT_FIXTURES: 'fixtures/draft/poc',
        DEV_GRPC_PORT: String(backendPort),
        DEV_HUB_PORT: String(backendPort + 1),
        DEV_HTTP_PORT: String(backendPort + 2),
        DEV_KEYCLOAK_PORT: String(backendPort + 3),
        DEV_DRAFT_PORT: String(backendPort + 4),
      },
    },
    {
      // make dev-bff-fake: the BFF relays /ai_grid.v1.* to that backend and asks its fake hub. It
      // serves the bundle too, as the deployed console does: the specs load each page from it,
      // with its headers (e2e/fixtures.ts).
      command: `go run ./cmd --port=${bffPort} --backend-address=127.0.0.1:${backendPort} --hub-api-url=http://127.0.0.1:${backendPort + 1} --fake-backend --static-assets-dir=../frontend/dist`,
      cwd: '../bff',
      url: `http://127.0.0.1:${bffPort}/healthcheck`,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
    },
    {
      // The frontend as it ships: the production bundle, served by `vite preview`, whose proxy is
      // the dev server's (vite.config.ts), so the identity headers are the same. The dev server's
      // unbundled modules and React's development build made pages load in seconds and reported
      // errors React's production build does not.
      command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
      // An API path, so the run starts once the proxy reaches the BFF (the backend has its own wait).
      url: `${origin}/api/v1/config`,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
      env: {
        BFF_URL: `http://127.0.0.1:${bffPort}`,
        AUTH_TOKEN: 'dev-token',
        AUTH_USER: 'dev-user',
      },
    },
  ],
});
