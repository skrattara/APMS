import { expect, test, type Locator } from '@playwright/test';

test('profiles the signed-in Faculty Dashboard before gradebook navigation', async ({ page }) => {
  test.setTimeout(120_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 10000 });
  await cdp.send('Profiler.start');
  await page.goto('/portal/faculty/overview');
  await page.waitForTimeout(20_000);
  const { profile } = await cdp.send('Profiler.stop');
  const sampleTimes = new Map<number, number>();
  profile.samples?.forEach((nodeId: number, index: number) => sampleTimes.set(nodeId, (sampleTimes.get(nodeId) ?? 0) + (profile.timeDeltas?.[index] ?? 0)));
  const hotFunctions = (profile.nodes ?? []).map((node: any) => ({
    function: node.callFrame.functionName || '(anonymous)',
    source: node.callFrame.url ? node.callFrame.url.split('/').at(-1) : '(runtime)',
    line: node.callFrame.lineNumber + 1,
    selfMs: Math.round((sampleTimes.get(node.id) ?? 0) / 1000),
  })).filter((node: any) => node.selfMs > 0).sort((a: any, b: any) => b.selfMs - a.selfMs).slice(0, 20);
  console.info('[Faculty Dashboard CPU profile]', JSON.stringify(hotFunctions));
  await cdp.detach();
});

test('250-student test class switches to Full View and scrolls without gradebook stalls', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const target = window as typeof window & { __gradebookPerf?: any };
    target.__gradebookPerf = {
      active: false,
      lastFrame: 0,
      maxFrameGapMs: 0,
      frames: 0,
      longTasks: [] as number[],
      observer: null as PerformanceObserver | null,
      raf: 0,
      start() {
        this.active = true;
        this.lastFrame = 0;
        this.maxFrameGapMs = 0;
        this.frames = 0;
        this.longTasks = [];
        if ('PerformanceObserver' in window) {
          this.observer = new PerformanceObserver((entries) => {
            this.longTasks.push(...entries.getEntries().map((entry) => entry.duration));
          });
          // Measure work after start(); buffered entries include page load and
          // make the scroll phase look slower than it actually is.
          try { this.observer.observe({ type: 'longtask', buffered: false }); } catch { /* unsupported browser */ }
        }
        const sample = (time: number) => {
          if (!this.active) return;
          if (this.lastFrame) this.maxFrameGapMs = Math.max(this.maxFrameGapMs, time - this.lastFrame);
          this.lastFrame = time;
          this.frames += 1;
          this.raf = requestAnimationFrame(sample);
        };
        this.raf = requestAnimationFrame(sample);
      },
      stop() {
        this.active = false;
        cancelAnimationFrame(this.raf);
        this.observer?.disconnect();
        return {
          sampledFrames: this.frames,
          maxFrameGapMs: Math.round(this.maxFrameGapMs),
          longTaskCount: this.longTasks.length,
          longestTaskMs: Math.round(Math.max(0, ...this.longTasks)),
        };
      },
    };
  });

  const supabaseStarts = new WeakMap<object, number>();
  const supabaseRequests: { path: string; status: number; durationMs: number }[] = [];
  page.on('request', (request) => {
    if (/\/rest\/v1\/|\/auth\/v1\//.test(request.url())) supabaseStarts.set(request, Date.now());
  });
  page.on('response', (response) => {
    const started = supabaseStarts.get(response.request());
    if (started == null) return;
    supabaseRequests.push({ path: new URL(response.url()).pathname, status: response.status(), durationMs: Date.now() - started });
  });

  await page.goto('/portal/faculty/overview');
  await expect(page.getByRole('heading', { name: 'Faculty Dashboard' })).toBeVisible({ timeout: 120_000 });
  const workspaceStarted = Date.now();
  const gradebookNavigation = page.getByRole('link', { name: /Gradebook/ });
  await expect(gradebookNavigation, 'Faculty sidebar should expose Gradebook navigation').toBeVisible();
  await gradebookNavigation.click();
  await page.waitForURL('**/portal/faculty/gradebook', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Class Gradebook' })).toBeVisible({ timeout: 120_000 });
  const workspaceLoadMs = Date.now() - workspaceStarted;

  const classPicker = page.getByRole('button', { name: 'Class', exact: true });
  await classPicker.click();
  const testClassOption = page.getByRole('button', { name: /TEST\s*-\s*/i }).last();
  await expect(testClassOption).toBeVisible();
  const testClassLabel = await testClassOption.innerText();
  await testClassOption.click();
  await expect(classPicker).toContainText(/TEST\s*-\s*/i);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const readCdpMetrics = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value])) as Record<string, number>;
  };
  const metricDelta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(
    ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize', 'Nodes', 'LayoutCount', 'RecalcStyleCount']
      .flatMap((name) => before[name] == null || after[name] == null ? [] : [[name, Number((after[name] - before[name]).toFixed(3))]]),
  );
  const profileCpu = process.env.APMS_E2E_CPU_PROFILE === '1';
  if (profileCpu) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 10000 });
    await cdp.send('Profiler.start');
  }
  const readCpuProfile = async () => {
    if (!profileCpu) return [];
    const { profile } = await cdp.send('Profiler.stop');
    const sampleTimes = new Map<number, number>();
    profile.samples?.forEach((nodeId: number, index: number) => sampleTimes.set(nodeId, (sampleTimes.get(nodeId) ?? 0) + (profile.timeDeltas?.[index] ?? 0)));
    await cdp.send('Profiler.start');
    return (profile.nodes ?? []).map((node: any) => ({
      function: node.callFrame.functionName || '(anonymous)',
      source: node.callFrame.url ? node.callFrame.url.split('/').at(-1) : '(runtime)',
      line: node.callFrame.lineNumber + 1,
      selfMs: Math.round((sampleTimes.get(node.id) ?? 0) / 1000),
    })).filter((node: any) => node.selfMs > 0).sort((a: any, b: any) => b.selfMs - a.selfMs).slice(0, 12);
  };
  const beforeFullViewMetrics = await readCdpMetrics();
  await page.evaluate(() => (window as any).__gradebookPerf.start());
  const switchStarted = Date.now();
  await page.getByRole('button', { name: 'Full View', exact: true }).click();
  await expect(page.getByText(/250 students · Showing all/)).toBeVisible();
  const grid = page.locator('[data-gradebook-grid="true"]');
  await expect(grid).toBeVisible();
  await expect(grid.locator('[data-gradebook-row]').first()).toBeVisible();
  const switchDurationMs = Date.now() - switchStarted;
  const switchPerf = await page.evaluate(() => (window as any).__gradebookPerf.stop());
  const switchCpuHotFunctions = await readCpuProfile();
  const afterFullViewMetrics = await readCdpMetrics();
  const hoverRgb = (locator: Locator) => locator.evaluate((element) => {
    const color = getComputedStyle(element).backgroundColor;
    const srgb = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (srgb) return srgb.slice(1, 4).map((channel) => Math.round(Number(channel) * 255));
    const rgb = color.match(/[\d.]+/g);
    return rgb?.slice(0, 3).map(Number) ?? [];
  });
  const hoveredClassCell = grid.locator('[data-gradebook-student][data-gradebook-column-id="student_class_number"]').first();
  await hoveredClassCell.hover();
  await expect.poll(() => hoverRgb(hoveredClassCell)).toEqual([238, 244, 255]);
  const adjacentClassCell = grid.locator('[data-gradebook-student][data-gradebook-column-id="student_class_number"]').nth(1);
  await expect.poll(() => hoverRgb(adjacentClassCell)).toEqual([246, 249, 254]);
  // Conditional-format colors become the hover tint's base instead of being
  // replaced by the generic blue hover shade. Verify both direct and adjacent
  // column tints without requiring a saved rule in the shared test class.
  await hoveredClassCell.evaluate((element) => element.style.setProperty('--gradebook-format-color', '#EAF6EC'));
  await expect.poll(() => hoverRgb(hoveredClassCell)).toEqual([235, 245, 243]);
  await adjacentClassCell.evaluate((element) => element.style.setProperty('--gradebook-format-color', '#EAF6EC'));
  await expect.poll(() => hoverRgb(adjacentClassCell)).toEqual([236, 247, 239]);
  await hoveredClassCell.evaluate((element) => element.style.removeProperty('--gradebook-format-color'));
  await adjacentClassCell.evaluate((element) => element.style.removeProperty('--gradebook-format-color'));
  const scrollTarget = await page.evaluate(() => {
    const gridRoot = document.querySelector('[data-gradebook-grid="true"]');
    if (!gridRoot) return null;
    const candidates = [...gridRoot.querySelectorAll<HTMLElement>('*')].filter((element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) && element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 100;
    });
    const element = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0];
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, range: element.scrollHeight - element.clientHeight };
  });
  expect(scrollTarget, 'Full View should have a vertically scrollable grade grid').not.toBeNull();
  expect(scrollTarget!.range).toBeGreaterThan(0);

  const preciseScroll = await grid.evaluate((root) => {
    const local = root.querySelector<HTMLElement>('[data-gradebook-scroll-viewport="true"]');
    if (!local) return null;
    local.scrollTop = 18.25;
    const localOffset = local.scrollTop;
    let global: HTMLElement | null = root.parentElement;
    while (global) {
      const style = getComputedStyle(global);
      if (/(auto|scroll)/.test(style.overflowY) && global.scrollHeight > global.clientHeight + 100) break;
      global = global.parentElement;
    }
    if (global) global.scrollTop = 18.25;
    const globalOffset = global?.scrollTop ?? null;
    const globalViewport = global ? { height: global.clientHeight, range: global.scrollHeight - global.clientHeight } : null;
    if (global) global.scrollTop = 0;
    local.scrollTop = 0;
    local.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { localOffset, globalOffset, globalViewport, localMax: local.scrollHeight - local.clientHeight };
  });
  expect(preciseScroll).not.toBeNull();
  expect(preciseScroll!.localMax).toBeGreaterThan(0);
  expect(Math.abs(preciseScroll!.localOffset - 18.25)).toBeLessThan(0.75);
  expect(preciseScroll!.globalViewport?.range ?? 0).toBeGreaterThan(0);
  expect(Math.abs((preciseScroll!.globalOffset ?? 0) - 18.25)).toBeLessThan(0.75);

  // Move across the mounted-row window. When the next input is not mounted, the
  // first navigation step scrolls/reveals it and focuses it after the render.
  await grid.locator('[data-gradebook-scroll-viewport="true"]').evaluate((element: HTMLElement) => {
    element.scrollTop = 1160;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const navigationInput = grid.locator('[data-gradebook-student] input').first();
  await expect(navigationInput).toBeVisible();
  await navigationInput.focus();
  let previousEnrollment = await page.evaluate(() => document.activeElement?.closest<HTMLElement>('[data-gradebook-student]')?.dataset.gradebookStudent ?? '');
  const keyboardStarted = Date.now();
  for (let step = 0; step < 46; step += 1) {
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest<HTMLElement>('[data-gradebook-student]')?.dataset.gradebookStudent ?? ''), { timeout: 3000 }).not.toBe(previousEnrollment);
    previousEnrollment = await page.evaluate(() => document.activeElement?.closest<HTMLElement>('[data-gradebook-student]')?.dataset.gradebookStudent ?? '');
  }
  const keyboardNavigationMs = Date.now() - keyboardStarted;

  // Also cross the horizontally virtualized window using the spreadsheet
  // arrow keys, including the reveal-and-focus path for an unmounted cell.
  const firstAssessmentInput = grid.locator('[data-gradebook-student][data-gradebook-column-id^="assessment:"] input').first();
  await expect(firstAssessmentInput).toBeVisible();
  await firstAssessmentInput.focus();
  const initialKeyboardColumnStart = Number(await grid.getAttribute('data-gradebook-column-window-start'));
  const horizontalKeyboardStarted = Date.now();
  for (let step = 0; step < 160; step += 1) {
    if (Number(await grid.getAttribute('data-gradebook-column-window-start')) > initialKeyboardColumnStart) break;
    await page.keyboard.press('ArrowRight');
  }
  await expect.poll(async () => Number(await grid.getAttribute('data-gradebook-column-window-start'))).toBeGreaterThan(initialKeyboardColumnStart);
  const horizontalKeyboardNavigationMs = Date.now() - horizontalKeyboardStarted;

  await page.mouse.move(scrollTarget!.x, scrollTarget!.y);
  const beforeScrollMetrics = await readCdpMetrics();
  await page.evaluate(() => (window as any).__gradebookPerf.start());
  const scrollStarted = Date.now();
  for (let step = 0; step < 16; step += 1) {
    await page.mouse.wheel(0, step % 2 === 0 ? 500 : -250);
    await page.waitForTimeout(60);
  }
  await page.mouse.wheel(0, 5000);
  await page.waitForTimeout(250);
  const scrollDurationMs = Date.now() - scrollStarted;
  const scrollPerf = await page.evaluate(() => (window as any).__gradebookPerf.stop());
  const afterScrollMetrics = await readCdpMetrics();
  const scrollCpuHotFunctions = await readCpuProfile();
  const gridScale = await grid.evaluate((element) => ({
    rows: Number(element.getAttribute('data-gradebook-student-count')),
    columns: Number(element.getAttribute('data-gradebook-visible-columns')),
    mountedRows: element.querySelectorAll('[data-gradebook-row]').length,
    mountedCells: element.querySelectorAll('[data-gradebook-hover-cell]').length,
    descendantNodes: element.querySelectorAll('*').length,
    selectOptions: element.querySelectorAll('.selectOptionRow').length,
    rowHeaderShadow: (element.querySelector('[data-gradebook-frozen-shadow="rows"]') as HTMLElement | null)?.style.boxShadow ?? null,
  }));
  expect(gridScale.mountedCells).toBeLessThan(gridScale.rows * gridScale.columns * 0.5);
  expect(gridScale.mountedRows).toBeLessThanOrEqual(20);
  if (gridScale.rows > 50) {
    await expect.poll(() => grid.locator('[data-gradebook-frozen-shadow="rows"]').evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none');
  }
  if (profileCpu) await cdp.send('Profiler.disable');
  const requestCounts = supabaseRequests.reduce<Record<string, number>>((counts, request) => {
    counts[request.path] = (counts[request.path] ?? 0) + 1;
    return counts;
  }, {});

  console.info('[Live gradebook performance]', JSON.stringify({
    testClass: testClassLabel,
    studentCount: 250,
    renderedGridScale: gridScale,
    workspaceLoadMs,
    supabaseRequestCount: supabaseRequests.length,
    supabaseRequestCountsByPath: requestCounts,
    slowestSupabaseRequests: [...supabaseRequests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    assessmentToFullViewMs: switchDurationMs,
    assessmentToFullView: switchPerf,
    fullViewBrowserMetrics: metricDelta(beforeFullViewMetrics, afterFullViewMetrics),
    preciseScroll,
    keyboardNavigationMs,
    horizontalKeyboardNavigationMs,
    scrollDurationMs,
    scroll: scrollPerf,
    scrollBrowserMetrics: metricDelta(beforeScrollMetrics, afterScrollMetrics),
    cpuHotFunctions: { fullView: switchCpuHotFunctions, scrolling: scrollCpuHotFunctions },
  }));
  const columnWindowStart = Number(await grid.getAttribute('data-gradebook-column-window-start'));
  const horizontalScroll = await grid.evaluate((root) => {
    const target = [...root.querySelectorAll<HTMLElement>('*')]
      .filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 100)
      .sort((left, right) => left.clientHeight - right.clientHeight)[0];
    if (!target) return null;
    const maxScrollLeft = target.scrollWidth - target.clientWidth;
    target.scrollLeft = maxScrollLeft;
    target.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { maxScrollLeft, scrollLeft: target.scrollLeft };
  });
  expect(horizontalScroll?.maxScrollLeft ?? 0).toBeGreaterThan(0);
  await expect.poll(async () => Number(await grid.getAttribute('data-gradebook-column-window-start'))).toBeGreaterThan(columnWindowStart);
  if (gridScale.columns > 50) {
    await expect.poll(() => grid.locator('[data-gradebook-frozen-shadow="columns"]').evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none');
  }
  const studentHeader = grid.getByText('STUDENT', { exact: true }).last();
  const sortStarted = Date.now();
  await studentHeader.click();
  await page.getByText('Sort and filter', { exact: true }).click();
  await page.getByText('Sort Student descending', { exact: true }).click();
  expect(await grid.locator('[data-gradebook-row]').count()).toBeLessThanOrEqual(34);
  const sortDurationMs = Date.now() - sortStarted;
  const firstVisibleStudentName = await grid.locator('[data-gradebook-column-id="student_name"]').first().innerText();
  const filterStarted = Date.now();
  await studentHeader.click();
  await page.getByText('Sort and filter', { exact: true }).click();
  await page.getByText('Filter Student…', { exact: true }).click();
  await page.getByPlaceholder('Enter text').fill(firstVisibleStudentName.trim());
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(grid.locator('[data-gradebook-row]')).toHaveCount(1);
  const filterDurationMs = Date.now() - filterStarted;
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('button', { name: 'Clear sort and filters' }).click();
  await page.getByLabel('Close view options').click();
  console.info('[Live gradebook sort/filter]', JSON.stringify({ sortDurationMs, filterDurationMs }));
  await expect(page.getByText(/250 students · Showing all/)).toBeVisible();
  await grid.locator('[data-gradebook-column-id="student_class_number"]').first().click({ button: 'right' });
  await expect(page.getByText('Copy class number')).toBeVisible();
  await cdp.detach();
});
