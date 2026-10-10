import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const storageState = path.resolve(process.env.APMS_E2E_STORAGE_STATE ?? 'playwright/.auth/faculty.json');
if (!existsSync(storageState)) {
  throw new Error(`Signed-in Faculty session not found at ${storageState}. Add the local Playwright storage state file, or set APMS_E2E_STORAGE_STATE to its path.`);
}

const webServerEnv = { ...process.env, EXPO_PUBLIC_DEMO_MODE: 'false', CI: '1' };
delete webServerEnv.EXPO_NO_DOTENV;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'gradebook-performance.spec.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'playwright-live-report', open: 'never' }]],
  outputDir: 'test-results/live-gradebook',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:8082',
    viewport: { width: 1440, height: 1000 },
    storageState,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm --workspace @apms/mobile run web -- --port 8082',
    url: 'http://127.0.0.1:8082',
    reuseExistingServer: false,
    timeout: 180_000,
    env: webServerEnv,
  },
  projects: [{ name: 'chromium-live', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
});
