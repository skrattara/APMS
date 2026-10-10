import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { collectSupabaseRequestTimings, expectFacultyDashboardReady, expectFacultyDashboardShell, installJourneyProbe, installLoginSubmitMarker, startJourneyDiagnostics } from './performance-probe';

test('Faculty sign-in reaches a loaded and responsive Dashboard', async ({ page, context }) => {
  test.setTimeout(12 * 60_000);
  await installJourneyProbe(page);
  await installLoginSubmitMarker(page);
  const supabase = collectSupabaseRequestTimings(page);
  await page.goto('/');
  await expect(page.getByPlaceholder('Enter your email')).toBeVisible({ timeout: 30_000 });
  console.info('Sign in to the visible local APMS window as the Faculty user for the 250-student test class. Timing starts when Sign In is clicked; credentials are not read or recorded by the test.');
  supabase.begin();
  await page.waitForFunction(() => (window as any).__apmsLoginSubmittedAt != null, { timeout: 10 * 60_000 });
  const startedAt = await page.evaluate(() => Number((window as any).__apmsLoginSubmittedAt));
  const shellDiagnostics = await startJourneyDiagnostics(page, 'login-to-dashboard-shell');
  await expectFacultyDashboardShell(page);
  const shellAt = Date.now();
  const shellTrace = await shellDiagnostics.stop();
  const shellResponsiveness = await page.evaluate(() => (window as any).__apmsJourneyProbe.stop());
  const shellRequests = supabase.summarize();

  await page.evaluate(() => (window as any).__apmsJourneyProbe.start());
  supabase.begin();
  const dataDiagnostics = await startJourneyDiagnostics(page, 'dashboard-shell-to-loaded');
  await expectFacultyDashboardReady(page);
  const loadedAt = Date.now();
  const dataTrace = await dataDiagnostics.stop();
  const dataResponsiveness = await page.evaluate(() => (window as any).__apmsJourneyProbe.stop());

  // Opening and dismissing the class picker verifies that the loaded dashboard
  // responds to input; this short interaction is timed separately.
  await page.evaluate(() => (window as any).__apmsJourneyProbe.start());
  const interactionStartedAt = Date.now();
  const classPicker = page.getByRole('button', { name: 'Class', exact: true });
  await classPicker.click();
  await expect(page.getByRole('button', { name: /TEST\s*-\s*/i }).last()).toBeVisible();
  await page.keyboard.press('Escape');
  const interactionMs = Date.now() - interactionStartedAt;
  const interactionResponsiveness = await page.evaluate(() => (window as any).__apmsJourneyProbe.stop());

  const storageStatePath = path.resolve(process.env.APMS_E2E_STORAGE_STATE ?? 'playwright/.auth/faculty.json');
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  console.info(`Saved local signed-in session for the separate Dashboard-to-gradebook journey: ${storageStatePath}`);
  console.info('[Dashboard startup journey]', JSON.stringify({
    signInToVisibleDashboardShellMs: shellAt - startedAt,
    dashboardShellToLoadedMs: loadedAt - shellAt,
    signInToLoadedDashboardMs: loadedAt - startedAt,
    dashboardInteractionMs: interactionMs,
    shellResponsiveness,
    dataLoadResponsiveness: dataResponsiveness,
    interactionResponsiveness,
    shellSupabase: shellRequests,
    dashboardDataSupabase: supabase.summarize(),
    shellTrace,
    dashboardDataTrace: dataTrace,
  }));
});
