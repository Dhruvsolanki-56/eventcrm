import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'tests/**/*.test.mjs', 'client/quick-capture.test.ts'], environment: 'node' },
});
