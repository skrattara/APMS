import { expect, test } from '@playwright/test';
import { collectSupabaseRequestTimings, expectFacultyDashboardReady, expectFacultyDashboardShell, installJourneyProbe, startJourneyDiagnostics } from './performance-probe';

test.use({ storageState: process.env.APMS_E2E_STORAGE_STATE ?? 'playwright/.auth/faculty.json' });

test('signed-in cold app start separates Faculty dashboard shell from hydrated modules', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await installJourneyProbe(page);
  const appStartedAt = Date.now();
  const supabase = collectSupabaseRequestTimings(page);
  supabase.begin();
  const shellDiagnostics = await startJourneyDiagnostics(page, 'signed-in-app-to-dashboard-shell');
  // Start timing at the first committed response; waiting for `load` here would
  // include every async app request before we even check for the visible shell.
  await page.goto('/portal/faculty/overview', { waitUntil: 'commit' });
  await expectFacultyDashboardShell(page);
  const shellAt = Date.now();
  const shellTrace = await shellDiagnostics.stop();
  const shellResponsiveness = await page.evaluate(() => (window as any).__apmsJourneyProbe.stop());
  const browserStartupResources = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return {
      navigation: navigation ? {
        responseStartMs: navigation.responseStart,
        domInteractiveMs: navigation.domInteractive,
        domContentLoadedMs: navigation.domContentLoadedEventEnd,
        loadEventMs: navigation.loadEventEnd,
      } : null,
      scripts: resources.filter((entry) => entry.initiatorType === 'script' || entry.name.includes('.bundle'))
        .map((entry) => ({ name: entry.name.split('/').pop()?.slice(0, 100), durationMs: Math.round(entry.duration), transferBytes: entry.transferSize, decodedBytes: entry.decodedBodySize }))
        .sort((left, right) => right.durationMs - left.durationMs).slice(0, 12),
    };
  });

  await page.evaluate(() => (window as any).__apmsJourneyProbe.start());
  supabase.begin();
  const hydrationDiagnostics = await startJourneyDiagnostics(page, 'dashboard-shell-to-hydrated');
  await expectFacultyDashboardReady(page);
  const hydratedAt = Date.now();
  const hydrationTrace = await hydrationDiagnostics.stop();
  const hydrationResponsiveness = await page.evaluate(() => (window as any).__apmsJourneyProbe.stop());

  console.info('[Signed-in dashboard hydration]', JSON.stringify({
    appStartToVisibleShellMs: shellAt - appStartedAt,
    shellToHydratedDashboardMs: hydratedAt - shellAt,
    appStartToHydratedDashboardMs: hydratedAt - appStartedAt,
    shellResponsiveness,
    hydrationResponsiveness,
    shellSupabase: supabase.summarize(appStartedAt, shellAt),
    hydrationSupabase: supabase.summarize(shellAt, hydratedAt),
    browserStartupResources,
    shellTrace,
    hydrationTrace,
  }));
});
