import { defineConfig } from '@playwright/test';
import { API, WEB } from './env.js';

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
        'npx next build --webpack && npx next start --port 3101 --hostname localhost',
      cwd: `${root}apps/web`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { SYNQ_API_ORIGIN: API },
    },
  ],
});
