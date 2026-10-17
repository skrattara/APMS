import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'services/ai/deploy/cloudflare',
  test: { include: ['src/**/*.test.ts'] },
});
