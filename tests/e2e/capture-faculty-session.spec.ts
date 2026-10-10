import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('sign in as Faculty and save a local E2E session', async ({ page, context }) => {
  const storageStatePath = path.resolve(process.env.APMS_E2E_STORAGE_STATE ?? 'playwright/.auth/faculty.json');
  await page.goto('/');
  await expect(page.getByPlaceholder('Enter your email')).toBeVisible();
  console.info('Sign in to the local APMS window with the Faculty account assigned to the 250-student test class. The session will be saved locally after the Faculty portal opens.');
  await page.waitForURL(/\/portal\/faculty(?:\/|$)/, { timeout: 10 * 60_000 });
  await expect(page.getByText('Faculty').first()).toBeVisible();
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  console.info(`Saved local Playwright session to ${storageStatePath}`);
});
