const TRACE_WINDOW_KEY = 'apms.debug.startup-trace-until';
const EXPLAIN_WINDOW_KEY = 'apms.debug.explain-rest-until';

let traceStartedAt: number | null = null;
let traceHasSeenLogin = false;

function isTraceEnabled() {
  try {
    const storage = globalThis.localStorage;
    const until = Number(storage?.getItem(TRACE_WINDOW_KEY) ?? 0);
    if (!storage || until <= Date.now()) {
      if (storage && until) storage.removeItem(TRACE_WINDOW_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isExplainCaptureEnabled() {
  try {
    const storage = globalThis.localStorage;
    const until = Number(storage?.getItem(EXPLAIN_WINDOW_KEY) ?? 0);
    if (!storage || until <= Date.now()) {
      if (storage && until) storage.removeItem(EXPLAIN_WINDOW_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function captureDatabasePlan(label: string, buildQuery: () => any) {
  if (!isExplainCaptureEnabled()) return;
  void (async () => {
    try {
      const { data, error } = await buildQuery().explain({ analyze: true, buffers: true, verbose: true, format: 'text' });
      if (error) console.error(`[APMS EXPLAIN] ${label} failed`, error);
      else console.info(`[APMS EXPLAIN] ${label}`, data);
    } catch (error) {
      console.error(`[APMS EXPLAIN] ${label} failed`, error);
    }
  })();
}

function now() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

export function tracePerformanceEvent(label: string, details?: Record<string, string | number | boolean | null>) {
  if (!isTraceEnabled()) return;
  if (label === 'login.submit') {
    traceStartedAt = now();
    traceHasSeenLogin = true;
  }
  if (traceStartedAt == null) return;
  const elapsedMs = Math.round(now() - traceStartedAt);
  console.info('[APMS startup trace]', { elapsedMs, label, ...details });
}

export function tracePerformanceSpan<T>(label: string, operation: () => PromiseLike<T>, details?: Record<string, string | number | boolean | null>): Promise<T> {
  if (!isTraceEnabled() || traceStartedAt == null) return Promise.resolve().then(operation);
  const started = now();
  return Promise.resolve().then(operation).then(
    (result) => {
      tracePerformanceEvent(label, { ...details, durationMs: Math.round(now() - started), outcome: 'success' });
      return result;
    },
    (error) => {
      tracePerformanceEvent(label, { ...details, durationMs: Math.round(now() - started), outcome: 'error' });
      throw error;
    },
  );
}

export function finishStartupTrace(label: string, details?: Record<string, string | number | boolean | null>) {
  if (isTraceEnabled() && traceStartedAt != null && traceHasSeenLogin) {
    tracePerformanceEvent(label, { ...details, totalDurationMs: Math.round(now() - traceStartedAt) });
    traceStartedAt = null;
    traceHasSeenLogin = false;
    try { globalThis.localStorage?.removeItem(TRACE_WINDOW_KEY); } catch { /* tracing is best-effort */ }
  }
  try { globalThis.localStorage?.removeItem(EXPLAIN_WINDOW_KEY); } catch { /* tracing is best-effort */ }
}
