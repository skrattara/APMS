import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type ProfileFrame = { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number };

function frameLabel(frame?: ProfileFrame) {
  if (!frame) return '(unknown)';
  const location = frame.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}` : '';
  return `${frame.functionName || '(anonymous)'}${location ? ` @ ${location}` : ''}`;
}

function safeRequestLabel(value: string) {
  try {
    const url = new URL(value);
    const queryKeys = [...new Set([...url.searchParams.keys()])].sort();
    return `${url.origin}${url.pathname}${queryKeys.length ? `?${queryKeys.join(',')}` : ''}`;
  } catch {
    return '(invalid URL)';
  }
}

function profileCallStacks(profile: any, weightByNodeId: Map<number, number>, limit = 12) {
  const byId = new Map<number, any>((profile?.nodes ?? []).map((node: any) => [node.id, node]));
  const parentById = new Map<number, number>();
  for (const node of profile?.nodes ?? []) for (const childId of node.children ?? []) parentById.set(childId, node.id);
  const frameWeights = new Map<string, number>();
  const stackWeights = new Map<string, number>();
  for (const [nodeId, weight] of weightByNodeId) {
    const frames: string[] = [];
    let current: number | undefined = nodeId;
    while (current != null && frames.length < 8) {
      const node = byId.get(current);
      if (!node) break;
      frames.push(frameLabel(node.callFrame));
      current = parentById.get(current);
    }
    const leaf = frames[0] ?? '(unknown)';
    frameWeights.set(leaf, (frameWeights.get(leaf) ?? 0) + weight);
    const stack = frames.reverse().join('  >  ');
    stackWeights.set(stack, (stackWeights.get(stack) ?? 0) + weight);
  }
  const top = (weights: Map<string, number>) => [...weights].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([stack, weight]) => ({ stack, weight: Math.round(weight) }));
  return { topFrames: top(frameWeights), topStacks: top(stackWeights) };
}

function profileWeightsBySample(profile: any) {
  const weights = new Map<number, number>();
  const samples: number[] = profile?.samples ?? [];
  const deltas: number[] = profile?.timeDeltas ?? [];
  samples.forEach((nodeId, index) => weights.set(nodeId, (weights.get(nodeId) ?? 0) + (deltas[index] ?? 1)));
  return weights;
}

function heapSampleWeights(profile: any) {
  const weights = new Map<number, number>();
  for (const sample of profile?.samples ?? []) weights.set(sample.nodeId, (weights.get(sample.nodeId) ?? 0) + sample.size);
  return weights;
}

export async function startJourneyDiagnostics(page: Page, journey: string) {
  const cdp = await page.context().newCDPSession(page);
  const networkStarted = new Map<string, { url: string; method: string; start: number; responseAt?: number; status?: number; mimeType?: string }>();
  const networkCompleted: { url: string; method: string; status?: number; mimeType?: string; durationMs: number; responseMs?: number; encodedBytes: number }[] = [];
  cdp.on('Network.requestWillBeSent', (event: any) => networkStarted.set(event.requestId, { url: event.request.url, method: event.request.method, start: event.timestamp }));
  cdp.on('Network.responseReceived', (event: any) => {
    const request = networkStarted.get(event.requestId);
    if (request) Object.assign(request, { responseAt: event.timestamp, status: event.response.status, mimeType: event.response.mimeType });
  });
  cdp.on('Network.loadingFinished', (event: any) => {
    const request = networkStarted.get(event.requestId);
    if (!request) return;
    networkCompleted.push({
      url: safeRequestLabel(request.url), method: request.method, status: request.status, mimeType: request.mimeType,
      durationMs: (event.timestamp - request.start) * 1000,
      responseMs: request.responseAt == null ? undefined : (request.responseAt - request.start) * 1000,
      encodedBytes: event.encodedDataLength ?? 0,
    });
    networkStarted.delete(event.requestId);
  });

  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const startedAt = Date.now();
  const before = await cdp.send('Performance.getMetrics');
  return {
    async stop() {
      const elapsedMs = Date.now() - startedAt;
      const [cpuResult, heapResult, after, heapUsage] = await Promise.all([
        cdp.send('Profiler.stop'),
        cdp.send('HeapProfiler.stopSampling'),
        cdp.send('Performance.getMetrics'),
        cdp.send('Runtime.getHeapUsage').catch(() => null),
      ]);
      await cdp.send('Profiler.disable').catch(() => {});
      await cdp.send('Network.disable').catch(() => {});
      await cdp.detach().catch(() => {});

      const cpuProfile = (cpuResult as any).profile;
      const heapProfile = (heapResult as any).profile;
      const cpuStacks = profileCallStacks(cpuProfile, profileWeightsBySample(cpuProfile));
      const heapStacks = profileCallStacks(heapProfile?.head ? { nodes: flattenHeapNodes(heapProfile.head) } : null, heapSampleWeights(heapProfile));
      const beforeMetrics = new Map(((before as any).metrics ?? []).map((metric: any) => [metric.name, metric.value]));
      const afterMetrics = new Map(((after as any).metrics ?? []).map((metric: any) => [metric.name, metric.value]));
      const metricNames = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'LayoutCount', 'RecalcStyleCount'];
      const metricDelta = Object.fromEntries(metricNames.flatMap((name) => {
        const start = beforeMetrics.get(name);
        const end = afterMetrics.get(name);
        return typeof start === 'number' && typeof end === 'number' ? [[name, end - start]] : [];
      }));
      const networkSummary = {
        completedRequests: networkCompleted.length,
        transferBytes: networkCompleted.reduce((sum, request) => sum + request.encodedBytes, 0),
        slowest: [...networkCompleted].sort((left, right) => right.durationMs - left.durationMs).slice(0, 15),
        largest: [...networkCompleted].sort((left, right) => right.encodedBytes - left.encodedBytes).slice(0, 15),
      };
      const report = {
        journey, elapsedMs,
        runtimeMetricsDelta: metricDelta,
        memory: {
          heapUsage: heapUsage ?? null,
          sampledAllocationBytes: (heapProfile?.samples ?? []).reduce((sum: number, sample: any) => sum + sample.size, 0),
          topAllocationStacks: heapStacks.topStacks,
          topAllocationFrames: heapStacks.topFrames,
        },
        cpu: {
          profileDurationMs: cpuProfile ? (cpuProfile.endTime - cpuProfile.startTime) / 1000 : null,
          topSelfTimeFrames: cpuStacks.topFrames,
          hotCallStacks: cpuStacks.topStacks,
        },
        network: networkSummary,
      };
      const artifact = path.resolve('test-results', 'performance-profiles', `${journey}-${new Date().toISOString().replaceAll(':', '-')}.json`);
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, JSON.stringify({ ...report, rawCpuProfile: cpuProfile, rawHeapProfile: heapProfile }, null, 2));
      return { ...report, artifact };
    },
  };
}

function flattenHeapNodes(root: any) {
  const nodes: any[] = [];
  const visit = (node: any, parent?: number) => {
    nodes.push({ id: node.id, callFrame: node.callFrame, children: node.children?.map((child: any) => child.id) ?? [], ...(parent == null ? {} : { parent }) });
    for (const child of node.children ?? []) visit(child, node.id);
  };
  visit(root);
  return nodes;
}

export async function installJourneyProbe(page: Page) {
  await page.addInitScript(() => {
    (window as any).__apmsJourneyProbe = {
      active: false,
      previousFrame: 0,
      maxFrameGapMs: 0,
      frames: 0,
      longTasks: [] as number[],
      observer: null as PerformanceObserver | null,
      raf: 0,
      start() {
        this.observer?.disconnect();
        cancelAnimationFrame(this.raf);
        this.active = true;
        this.previousFrame = 0;
        this.maxFrameGapMs = 0;
        this.frames = 0;
        this.longTasks = [];
        if ('PerformanceObserver' in window) {
          this.observer = new PerformanceObserver((entries) => {
            this.longTasks.push(...entries.getEntries().map((entry) => entry.duration));
          });
          try { this.observer.observe({ type: 'longtask', buffered: false }); } catch { /* unsupported browser */ }
        }
        const sample = (time: number) => {
          if (!this.active) return;
          if (this.previousFrame) this.maxFrameGapMs = Math.max(this.maxFrameGapMs, time - this.previousFrame);
          this.previousFrame = time;
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
    (window as any).__apmsJourneyProbe.start();
  });
}

export async function installLoginSubmitMarker(page: Page) {
  await page.addInitScript(() => {
    (window as any).__apmsLoginSubmittedAt = null;
    document.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      const button = target?.closest('button,[role="button"]');
      if (!button || !/sign in/i.test(button.textContent ?? '')) return;
      (window as any).__apmsLoginSubmittedAt = Date.now();
      (window as any).__apmsJourneyProbe?.start();
    }, true);
  });
}

export function collectSupabaseRequestTimings(page: Page) {
  let captureSince = Number.NEGATIVE_INFINITY;
  const starts = new WeakMap<object, number>();
  const requests: { path: string; status: number; durationMs: number; startedAt: number }[] = [];
  page.on('request', (request) => {
    if (!/\/rest\/v1\/|\/auth\/v1\//.test(request.url())) return;
    starts.set(request, Date.now());
  });
  page.on('response', (response) => {
    const started = starts.get(response.request());
    if (started == null || started < captureSince) return;
    requests.push({ path: new URL(response.url()).pathname, status: response.status(), durationMs: Date.now() - started, startedAt: started });
  });
  return {
    begin() { captureSince = Date.now(); return captureSince; },
    summarize(since = captureSince, until = Number.POSITIVE_INFINITY) {
      const matchingRequests = requests.filter((request) => request.startedAt >= since && request.startedAt < until);
      const counts = matchingRequests.reduce<Record<string, number>>((result, request) => {
        result[request.path] = (result[request.path] ?? 0) + 1;
        return result;
      }, {});
      return {
        count: matchingRequests.length,
        countsByPath: counts,
        slowest: [...matchingRequests].sort((left, right) => right.durationMs - left.durationMs).slice(0, 8).map(({ startedAt: _startedAt, ...request }) => request),
      };
    },
  };
}

export async function expectFacultyDashboardReady(page: Page) {
  await expectFacultyDashboardShell(page);
  await expect(page.getByRole('heading', { name: 'Faculty Dashboard' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Students monitored', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/250 records match these filters/)).toBeVisible({ timeout: 90_000 });
}

export async function expectFacultyDashboardShell(page: Page) {
  await expect(page.getByTestId('faculty-dashboard-shell')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Faculty Dashboard' })).toBeVisible({ timeout: 90_000 });
}

export async function assertSignedInFaculty(page: Page) {
  const emailField = page.getByPlaceholder('Enter your email');
  if (await emailField.isVisible().catch(() => false)) {
    console.info('The saved session is no longer valid. Sign in to the visible local APMS window; dashboard-to-gradebook timing begins after the dashboard is ready.');
    await page.waitForFunction(() => (window as any).__apmsLoginSubmittedAt != null, { timeout: 10 * 60_000 });
  }
  await expectFacultyDashboardReady(page);
}
