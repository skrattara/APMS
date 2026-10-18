export const REQUEST_DEADLINE_MS = 90_000
export const REQUEST_BODY_LIMIT_BYTES = 1_000_000
export const PROVIDER_RESPONSE_LIMIT_BYTES = 2_000_000

export type RequestTrace = {
  id: string
  startedAt: number
  deadlineAt: number
  controller: AbortController
  stage: string
  provider?: 'openai' | 'gemini' | 'custom'
  phase?: 'status' | 'prediction'
  upstreamStatus?: number
  failureCode?: string
  recordCount?: number
  status?: number
  loggedStages?: Set<string>
}

export function createRequestTrace(now = Date.now): RequestTrace {
  const startedAt = now()
  return {
    id: crypto.randomUUID(),
    startedAt,
    deadlineAt: startedAt + REQUEST_DEADLINE_MS,
    controller: new AbortController(),
    stage: 'request',
    loggedStages: new Set(),
  }
}

export function remainingRequestMs(trace: RequestTrace, now = Date.now): number {
  return Math.max(0, trace.deadlineAt - now())
}

export async function withinRequestDeadline<T>(
  trace: RequestTrace,
  operation: Promise<T>,
  now = Date.now,
): Promise<T> {
  const remaining = remainingRequestMs(trace, now)
  if (remaining <= 0) {
    trace.controller.abort()
    throw new RequestDeadlineError()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestDeadlineError())
      queueMicrotask(() => trace.controller.abort())
    }, remaining)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class RequestDeadlineError extends Error {
  constructor() { super('request_deadline_exceeded'); this.name = 'RequestDeadlineError' }
}

export class RequestAuthorizationError extends Error {
  constructor() { super('authentication_required'); this.name = 'RequestAuthorizationError' }
}

/** Wrap fetch so Supabase SDK calls inherit this request's abort signal. */
export function requestBoundFetch(trace: RequestTrace, baseFetch: typeof fetch = fetch): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const inputSignal = input instanceof Request ? input.signal : undefined
    const upstreamSignal = init?.signal ?? inputSignal
    if (trace.controller.signal.aborted || upstreamSignal?.aborted) abort()
    else {
      trace.controller.signal.addEventListener('abort', abort, { once: true })
      upstreamSignal?.addEventListener('abort', abort, { once: true })
    }
    // Keep the request-level abort listener alive after headers arrive; callers
    // may still be consuming a streaming response body.
    return baseFetch(input, { ...init, signal: controller.signal })
  }
}

export function setRequestStage(trace: RequestTrace, stage: string, now = Date.now): void {
  trace.stage = stage
  if (trace.loggedStages?.has(stage)) return
  trace.loggedStages?.add(stage)
  console.info(JSON.stringify({
    event: 'apms_prediction_stage',
    request_id: trace.id,
    stage,
    elapsed_ms: Math.max(0, now() - trace.startedAt),
    ...(trace.provider ? { provider: trace.provider } : {}),
    ...(trace.phase ? { phase: trace.phase } : {}),
    ...(trace.upstreamStatus ? { upstream_status: trace.upstreamStatus } : {}),
    ...(trace.failureCode ? { error_code: trace.failureCode } : {}),
    ...(Number.isSafeInteger(trace.recordCount) ? { record_count: trace.recordCount } : {}),
  }))
}

export function addRequestTrace(response: Response, traceId: string): Response {
  const headers = new Headers(response.headers)
  headers.set('X-APMS-Request-ID', traceId)
  headers.set('Access-Control-Expose-Headers', [headers.get('Access-Control-Expose-Headers'), 'X-APMS-Request-ID']
    .filter(Boolean).join(', '))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** Only emit operational metadata; never attach request data or exception text. */
export function logRequestTrace(trace: RequestTrace, now = Date.now): void {
  console.info(JSON.stringify({
    event: 'apms_prediction_request',
    request_id: trace.id,
    stage: trace.stage,
    status: trace.status ?? 500,
    elapsed_ms: Math.max(0, now() - trace.startedAt),
    ...(trace.provider ? { provider: trace.provider } : {}),
    ...(trace.phase ? { phase: trace.phase } : {}),
    ...(trace.upstreamStatus ? { upstream_status: trace.upstreamStatus } : {}),
    ...(trace.failureCode ? { error_code: trace.failureCode } : {}),
    ...(Number.isSafeInteger(trace.recordCount) ? { record_count: trace.recordCount } : {}),
  }))
}

export async function readBoundedResponseText(response: Response, maximumBytes: number, signal?: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw new BoundedResponseError()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (signal?.aborted) throw new DOMException('request aborted', 'TimeoutError')
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      cancel()
      throw new BoundedResponseError()
    }
    chunks.push(value)
  }
  signal?.removeEventListener('abort', cancel)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export class BoundedResponseError extends Error {
  constructor() { super('response_limit_exceeded'); this.name = 'BoundedResponseError' }
}

export class BoundedRequestError extends Error {
  constructor(readonly tooLarge: boolean) { super(tooLarge ? 'request_too_large' : 'invalid_request_body'); this.name = 'BoundedRequestError' }
}

/** Validate the bearer syntax and read/parse the bounded body before auth I/O. */
export async function readBodyThenAuthenticate<T>(
  request: Request,
  maximumBytes: number,
  trace: RequestTrace,
  authenticate: (token: string, authorization: string) => Promise<T>,
): Promise<{ authorization: string; body: unknown; authentication: T }> {
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) throw new RequestAuthorizationError()
  setRequestStage(trace, 'request_body')
  const bytes = await withinRequestDeadline(trace, readBoundedRequestBytes(request, maximumBytes, trace.controller.signal))
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(bytes)) }
  catch { throw new BoundedRequestError(false) }
  setRequestStage(trace, 'authentication')
  const authentication = await withinRequestDeadline(trace, authenticate(authorization.slice('Bearer '.length), authorization))
  return { authorization, body, authentication }
}

export async function readBoundedRequestBytes(request: Request, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new BoundedRequestError(true)
  if (!request.body) throw new BoundedRequestError(false)
  const reader = request.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new DOMException('request aborted', 'TimeoutError')
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        cancel()
        throw new BoundedRequestError(true)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof BoundedRequestError) throw error
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
