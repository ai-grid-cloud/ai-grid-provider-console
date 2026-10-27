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

/** The BFF's paths: its API, and the Monitoring page's relay to the hub's Perses. */
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

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 9000),
    strictPort: true,
    proxy: {
      '/api': toBff,
      '/perses/api': toBff,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    // Playwright specs run with `pnpm e2e`.
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
});
