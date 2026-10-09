import { defineConfig } from 'vitest/config';

// Real Monad testnet run: spends test MON/AUSD, so it is never part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['tests/e2e/testnet.e2e.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
  },
});
