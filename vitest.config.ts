import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'tests/**/*.test.mjs'], environment: 'node' },
});
