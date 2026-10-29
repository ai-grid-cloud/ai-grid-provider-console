/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * Local development against a real cluster.
 *
 * The BFF expects the caller's identity in the headers kube-auth-proxy sets in a
 * deployed console: the OpenShift token in `x-forwarded-access-token` and the
 * user name in `x-forwarded-user`. Here the dev proxy sets them from `oc whoami`,
 * so whoever ran `oc login` is the console user. They are re-read after a 401 so
 * a fresh `oc login` is picked up without a restart.
 *
 * Environment:
 *   BFF_URL      BFF base URL (default http://127.0.0.1:8080)
 *   FRONTEND_PORT  dev server port (default 9000)
 *   AUTH_TOKEN   use this token instead of running `oc whoami -t`
 *   AUTH_USER    use this user name instead of running `oc whoami`
 *   AUTH_GROUPS  comma-separated groups to send in `x-forwarded-groups`
 */
const bffUrl = process.env.BFF_URL ?? 'http://127.0.0.1:8080';
const tokenHeader = process.env.AUTH_TOKEN_HEADER ?? 'x-forwarded-access-token';
const userHeader = process.env.AUTH_USER_HEADER ?? 'x-forwarded-user';
const groupsHeader = process.env.AUTH_GROUPS_HEADER ?? 'x-forwarded-groups';

type Caller = { token: string; user: string };

let cached: Caller | undefined;

const oc = (...args: string[]): string =>
  execFileSync('oc', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();

const caller = (): Caller => {
  if (cached) {
    return cached;
  }
  const whoami = (...args: string[]): string | undefined => {
    try {
      return oc('whoami', ...args);
    } catch {
      return undefined;
    }
  };
  const token = process.env.AUTH_TOKEN ?? whoami('-t');
  if (!token) {
    cached = { token: '', user: '' };
    console.warn(
      '[dev-proxy] no oc login found; API calls will fail with 401 until you run `oc login` or set AUTH_TOKEN',
    );
    return cached;
  }
  // With AUTH_TOKEN set, `oc` may not be logged in; fall back to a fixed name.
  const user = process.env.AUTH_USER ?? whoami() ?? 'dev-user';
  cached = { token, user };
  console.info(`[dev-proxy] forwarding API calls to ${bffUrl} as ${user}`);
  return cached;
};

/** The BFF's paths: its API, the Monitoring page's relay to the hub's Perses, and the Connect relay to the backend. */
const toBff: ProxyOptions = {
  target: bffUrl,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      const { token, user } = caller();
      if (token) {
        proxyReq.setHeader(tokenHeader, token);
        proxyReq.setHeader(userHeader, user);
        if (process.env.AUTH_GROUPS) {
          proxyReq.setHeader(groupsHeader, process.env.AUTH_GROUPS);
        }
      }
    });
    proxy.on('proxyRes', (proxyRes) => {
      if (proxyRes.statusCode === 401) {
        cached = undefined;
      }
    });
  },
};

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  resolve: {
    // The dev server only: Perses 0.56 is "type": "module" and default-imports mdi-material-ui's icons by
    // extensionless paths (mdi-material-ui/Circle), which are CommonJS files; mdi-material-ui has no
    // "exports" map. Vite's dependency pre-bundling (esbuild) then follows Node's rules for an ES
    // module importing CommonJS, and the default import becomes the whole module.exports object
    // ({ __esModule, default }), so rendering a Perses icon fails ("Element type is invalid"). The
    // same icons in mdi-material-ui/esm/ are ES modules. The production build (Rollup) and Vitest
    // (which inlines @perses-dev below) honour __esModule and don't need this. Remove it once
    // Perses imports the icons in a form ES modules can load.
    alias:
      command === 'serve' && mode !== 'test'
        ? [{ find: /^mdi-material-ui\/(?!esm\/)(.+)$/, replacement: 'mdi-material-ui/esm/$1' }]
        : [],
  },
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 9000),
    strictPort: true,
    proxy: {
      '/api': toBff,
      '/perses/api': toBff,
      // The backend's own RPCs over Connect (src/api/connect), which the BFF relays (bff/internal/relay).
      '^/ai_grid\\.v1\\.': toBff,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      treeshake: {
        // @perses-dev/components doesn't declare "sideEffects": false (client, dashboards, explore,
        // plugin-system and spec do; the plugins don't either). So Rollup follows every import its
        // index reaches, used or not, and keeps the top-level code of what they import: the YAML
        // editor's yaml and @lezer/yaml (about 36 kB gzipped in the Monitoring chunk), which the
        // console never shows. This only drops a components module none of whose exports is used:
        // EChart.js, which registers the ECharts charts and components at its top level, stays,
        // because the chart plugins import EChart; and the fonts come from @fontsource, outside this
        // rule. Remove it once Perses declares "sideEffects" for components.
        moduleSideEffects: (id) => !id.includes('/@perses-dev/components/'),
      },
    },
  },
  test: {
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    // Every test starts with the real functions and globals: spies (vi.spyOn) and vi.stubGlobal are
    // undone before each test, so no file restores them by hand.
    restoreMocks: true,
    unstubGlobals: true,
    // The same time zone and locale on every machine: the console formats dates, numbers and
    // relative times in the browser's, and the tests expect UTC and English. Vitest starts its
    // workers with this environment, so it is set before Node reads it.
    env: { TZ: 'UTC', LC_ALL: 'en_US.UTF-8' },
    // Playwright specs run with `pnpm e2e`.
    exclude: ['**/node_modules/**', 'e2e/**'],
    // Perses 0.56 is "type": "module" and imports mdi-material-ui/<Icon> without an extension, which
    // Node's ES module resolver refuses ("Cannot find module"). Inlined, Vite resolves those imports.
    server: { deps: { inline: [/@perses-dev\//] } },
    // Setting up jsdom costs far more per file than most logic tests take, so only components get
    // it. A *.test.ts file that needs the DOM says so with `// @vitest-environment jsdom`.
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts'] } },
      { extends: true, test: { name: 'jsdom', environment: 'jsdom', include: ['src/**/*.test.tsx'] } },
    ],
  },
}));
