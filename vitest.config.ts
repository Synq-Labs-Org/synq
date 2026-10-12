import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    exclude: [
      ...configDefaults.exclude,
      '.claude/**',
      'contracts/lib/**',
      'packages/metamask-synq-plugin/**',
    ],
  },
});
