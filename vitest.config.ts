import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/mobile/src/**/*.test.ts', 'apps/mobile/src/**/*.test.tsx', 'supabase/functions/_shared/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
