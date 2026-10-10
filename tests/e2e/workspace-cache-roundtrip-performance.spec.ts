import { expect, test } from '@playwright/test';
import { collectSupabaseRequestTimings, expectFacultyDashboardReady, installJourneyProbe, installLoginSubmitMarker, startJourneyDiagnostics } from './performance-probe';

test.use({ storageState: { cookies: [], origins: [] } });

test('cold Faculty sign-in and Dashboard/Full View round trip reuses the workspace cache', async ({ page }) => {
  test.setTimeout(12 * 60_000);
  await installJourneyProbe(page);
  await installLoginSubmitMarker(page);
  const supabase = collectSupabaseRequestTimings(page);
  await page.goto('/');
  await expect(page.getByPlaceholder('Enter your email')).toBeVisible({ timeout: 30_000 });
  console.info('Cold start: sign in to the visible local APMS browser as Faculty. The test clears browser storage and will time sign-in through the first Full View.');
  await page.waitForFunction(() => (window as any).__apmsLoginSubmittedAt != null, { timeout: 10 * 60_000 });
  const loginStartedAt = await page.evaluate(() => Number((window as any).__apmsLoginSubmittedAt));
  const firstDiagnostics = await startJourneyDiagnostics(page, 'cold-login-to-full-view');
  await expectFacultyDashboardReady(page);
  const dashboardReadyAt = Date.now();

  const openGradebook = async () => {
    const nav = page.getByText('Gradebook', { exact: true }).last();
    await expect(nav).toBeVisible();
    await nav.click();
    await page.waitForURL('**/portal/faculty/gradebook', { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Class Gradebook' })).toBeVisible({ timeout: 90_000 });
    const classPicker = page.getByRole('button', { name: 'Class', exact: true });
    await classPicker.click();
    const testClassOption = page.getByRole('button', { name: /TEST\s*-\s*/i }).last();
    await expect(testClassOption).toBeVisible();
    const testClass = (await testClassOption.innerText()).trim();
    await testClassOption.click();
    await expect(classPicker).toContainText(/TEST\s*-\s*/i);
    await expect(page.getByRole('button', { name: 'Full View', exact: true })).toBeVisible({ timeout: 90_000 });
    const viewStartedAt = Date.now();
    await page.getByRole('button', { name: 'Full View', exact: true }).click();
    const grid = page.locator('[data-gradebook-grid="true"]');
    await expect(grid).toBeVisible();
    await expect(grid.locator('[data-gradebook-row]').first()).toBeVisible();
    await expect.poll(() => grid.evaluate((element) => Number(element.getAttribute('data-gradebook-student-count')))).toBe(250);
    return { testClass, viewStartedAt, readyAt: Date.now() };
  };

  const firstFullView = await openGradebook();
  const firstTrace = await firstDiagnostics.stop();
  const firstRequests = supabase.summarize();

  const returnDiagnostics = await startJourneyDiagnostics(page, 'full-view-dashboard-full-view-return');
  supabase.begin();
  const returnStartedAt = Date.now();
  await page.getByText('Dashboard', { exact: true }).last().click();
  await page.waitForURL('**/portal/faculty/overview', { timeout: 30_000 });
  await expectFacultyDashboardReady(page);
  const dashboardReturnedAt = Date.now();
  const secondFullView = await openGradebook();
  const returnRequests = supabase.summarize();
  const returnTrace = await returnDiagnostics.stop();

  console.info('[Cold workspace cache round trip]', JSON.stringify({
    testClass: firstFullView.testClass,
    signInToDashboardMs: dashboardReadyAt - loginStartedAt,
    signInToFirstFullViewMs: firstFullView.readyAt - loginStartedAt,
    dashboardToFirstFullViewMs: firstFullView.readyAt - dashboardReadyAt,
    firstFullViewMountMs: firstFullView.readyAt - firstFullView.viewStartedAt,
    FullViewToDashboardMs: dashboardReturnedAt - returnStartedAt,
    reopenedDashboardToFullViewMs: secondFullView.readyAt - dashboardReturnedAt,
    secondFullViewMountMs: secondFullView.readyAt - secondFullView.viewStartedAt,
    firstSupabaseRequests: firstRequests,
    returnSupabaseRequests: returnRequests,
    firstTrace,
    returnTrace,
  }));
});
