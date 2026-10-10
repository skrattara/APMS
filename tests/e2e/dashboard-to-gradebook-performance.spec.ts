import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertSignedInFaculty, collectSupabaseRequestTimings, installJourneyProbe, installLoginSubmitMarker, startJourneyDiagnostics } from './performance-probe';

test('ready Faculty Dashboard opens a loaded and responsive Full View gradebook', async ({ page, context }) => {
  test.setTimeout(12 * 60_000);
  await installJourneyProbe(page);
  await installLoginSubmitMarker(page);
  await page.goto('/portal/faculty/overview');
  await assertSignedInFaculty(page);
  await expect(page.getByRole('heading', { name: 'Faculty Dashboard' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/250 records match these filters/)).toBeVisible({ timeout: 90_000 });
  const storageStatePath = path.resolve(process.env.APMS_E2E_STORAGE_STATE ?? 'playwright/.auth/faculty.json');
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });

  const supabase = collectSupabaseRequestTimings(page);
  supabase.begin();
  const diagnostics = await startJourneyDiagnostics(page, 'dashboard-to-full-view-gradebook');
  await page.evaluate(() => (window as any).__apmsJourneyProbe.start());
  const journeyStartedAt = Date.now();
  const gradebookNavItem = page.getByText('Gradebook', { exact: true }).last();
  await expect(gradebookNavItem).toBeVisible();
  await gradebookNavItem.click();
  await page.waitForURL('**/portal/faculty/gradebook', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Class Gradebook' })).toBeVisible({ timeout: 90_000 });

  const classPicker = page.getByRole('button', { name: 'Class', exact: true });
  await classPicker.click();
  const testClassOption = page.getByRole('button', { name: /TEST\s*-\s*/i }).last();
  await expect(testClassOption).toBeVisible();
  const testClassLabel = (await testClassOption.innerText()).trim();
  await testClassOption.click();
  await expect(classPicker).toContainText(/TEST\s*-\s*/i);

  await expect(page.getByRole('button', { name: 'Full View', exact: true })).toBeVisible({ timeout: 90_000 });
  const fullViewStartedAt = Date.now();
  await page.getByRole('button', { name: 'Full View', exact: true }).click();
  await expect(page.getByText(/250 students · Showing all/)).toBeVisible({ timeout: 90_000 });
  const grid = page.locator('[data-gradebook-grid="true"]');
  await expect(grid).toBeVisible();
  await expect(grid.locator('[data-gradebook-row]').first()).toBeVisible();
  await expect.poll(() => grid.evaluate((element) => Number(element.getAttribute('data-gradebook-student-count')))).toBe(250);
  const fullViewReadyAt = Date.now();

  // Confirm the gradebook is interactive without involving scroll behavior.
  const optionsStartedAt = Date.now();
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  await expect(page.getByText('Show class number', { exact: true })).toBeVisible();
  const viewOptionsResponsiveMs = Date.now() - optionsStartedAt;
  await page.getByLabel('Close view options').click();
  const responsiveness = await page.evaluate(() => (window as any).__apmsJourneyProbe.stop());
  const runtimeTrace = await diagnostics.stop();

  console.info('[Dashboard to gradebook journey]', JSON.stringify({
    testClass: testClassLabel,
    dashboardClickToFullViewReadyMs: fullViewReadyAt - journeyStartedAt,
    gradebookNavigationAndClassLoadMs: fullViewStartedAt - journeyStartedAt,
    fullViewMountMs: fullViewReadyAt - fullViewStartedAt,
    viewOptionsResponsiveMs,
    responsiveness,
    supabase: supabase.summarize(),
    runtimeTrace,
  }));
});
