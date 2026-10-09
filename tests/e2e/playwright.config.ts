import { defineConfig } from '@playwright/test';
import { API, E2E_ADMIN_TOKEN, E2E_DATABASE_URL as dbUrl, WEB } from './env.js';

const root = new URL('../../', import.meta.url).pathname;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.pw\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command:
        'node --import tsx tests/e2e/prepare-db.ts && node --import tsx apps/api/src/v1-server.ts',
      cwd: root,
      url: `${API}/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        SYNQ_DATABASE_URL: dbUrl,
        SYNQ_E2E_DATABASE_URL: dbUrl,
        SYNQ_PROFILE: 'sandbox/monad-testnet',
        SYNQ_RP_ID: 'localhost',
        SYNQ_ORIGIN: WEB,
        SYNQ_API_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
        SYNQ_TRUST_PROXY: '127.0.0.1',
        SYNQ_RATE_LIMIT_CAPACITY: '60',
        SYNQ_API_PORT: '3201',
      },
    },
    {
      command:
        'npx next build --webpack && npx next start --port 3101 --hostname localhost',
      cwd: `${root}apps/web`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { SYNQ_API_ORIGIN: API },
    },
  ],
});
