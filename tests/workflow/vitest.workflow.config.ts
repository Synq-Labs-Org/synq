import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/workflow/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
