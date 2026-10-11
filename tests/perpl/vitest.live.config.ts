import { defineConfig } from 'vitest/config';

// Opt-in REAL_TESTNET and MAINNET_READ_ONLY Perpl suite (`pnpm test:live:p10`).
// It spends test MON on Monad testnet and is never part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['tests/perpl/live/*.live.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
