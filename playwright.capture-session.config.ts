import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const webServerEnv = { ...process.env, EXPO_PUBLIC_DEMO_MODE: 'false', CI: '1' };
delete webServerEnv.EXPO_NO_DOTENV;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'capture-faculty-session.spec.ts',
  timeout: 12 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:8082',
    viewport: { width: 1440, height: 1000 },
    channel: 'msedge',
    headless: false,
  },
  webServer: {
    command: 'npm --workspace @apms/mobile run web -- --port 8082',
    url: 'http://127.0.0.1:8082',
    reuseExistingServer: false,
    timeout: 180_000,
    env: webServerEnv,
  },
});
