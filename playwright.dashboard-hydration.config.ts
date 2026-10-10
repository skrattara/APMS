import { defineConfig, devices } from '@playwright/test';

const webServerEnv = { ...process.env, EXPO_PUBLIC_DEMO_MODE: 'false', CI: '1' };
delete webServerEnv.EXPO_NO_DOTENV;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'dashboard-hydration-performance.spec.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'playwright-dashboard-hydration-report', open: 'never' }]],
  outputDir: 'test-results/dashboard-hydration',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'msedge',
    headless: false,
    baseURL: 'http://127.0.0.1:8082',
    storageState: process.env.APMS_E2E_STORAGE_STATE ?? 'playwright/.auth/faculty.json',
    viewport: { width: 1440, height: 1000 },
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
  projects: [{ name: 'dashboard-hydration', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
});
