import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoundedRequestError,
  BoundedResponseError,
  addRequestTrace,
  createRequestTrace,
  logRequestTrace,
  readBoundedRequestBytes,
  readBoundedResponseText,
  readBodyThenAuthenticate,
  requestBoundFetch,
  setRequestStage,
  withinRequestDeadline,
} from '../../../../supabase/functions/_shared/requestLifecycle'
import { AIServiceError, safeAIServiceFailure } from '../../../../supabase/functions/_shared/aiService'

afterEach(() => vi.restoreAllMocks())

describe('prediction gateway request lifecycle', () => {
  it('rejects declared and streamed oversized bodies without awaiting cancellation', async () => {
    const declared = new Request('https://example.test', {
      method: 'POST', headers: { 'content-length': '1001' }, body: 'x'.repeat(1001),
    })
    await expect(readBoundedRequestBytes(declared, 1000)).rejects.toMatchObject({ tooLarge: true })

    let cancelCalled = false
    const streamed = new Request('https://example.test', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(700)); controller.enqueue(new Uint8Array(400)) },
        cancel() { cancelCalled = true },
      }),
      // No content-length: exercise the streaming byte counter.
      duplex: 'half',
    } as RequestInit)
    await expect(readBoundedRequestBytes(streamed, 1000)).rejects.toBeInstanceOf(BoundedRequestError)
    expect(cancelCalled).toBe(true)
  })

  it('rejects oversized requests before invoking authentication and authenticates only after JSON parsing', async () => {
    const trace = createRequestTrace()
    let authCalls = 0
    const tooLarge = new Request('https://example.test', {
      method: 'POST',
      headers: { Authorization: 'Bearer opaque', 'content-length': '1100' },
      body: 'x'.repeat(1100),
    })
    await expect(readBodyThenAuthenticate(tooLarge, 1000, trace, async () => { authCalls++; return true }))
      .rejects.toMatchObject({ tooLarge: true })
    expect(authCalls).toBe(0)

    const valid = new Request('https://example.test', {
      method: 'POST',
      headers: { Authorization: 'Bearer opaque', 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    })
    const result = await readBodyThenAuthenticate(valid, 1000, trace, async (token) => {
      authCalls++
      expect(token).toBe('opaque')
      return 'authenticated'
    })
    expect(result.body).toEqual({ ok: true })
    expect(result.authentication).toBe('authenticated')
    expect(authCalls).toBe(1)
  })

  it('bounds a stalled authentication request with the same per-request deadline', async () => {
    const trace = createRequestTrace()
    trace.deadlineAt = Date.now() + 15
    const request = new Request('https://example.test', {
      method: 'POST', headers: { Authorization: 'Bearer opaque' }, body: '{}',
    })
    await expect(readBodyThenAuthenticate(request, 100, trace, () => new Promise(() => undefined)))
      .rejects.toMatchObject({ name: 'RequestDeadlineError' })
    expect(trace.controller.signal.aborted).toBe(true)
  })

  it('bounds provider response bytes and consumes the body once', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); controller.enqueue(new TextEncoder().encode('true}')); controller.close() },
    }), { headers: { 'content-type': 'application/json' } })
    await expect(readBoundedResponseText(response, 32)).resolves.toBe('{"ok":true}')

    const tooLarge = new Response('x'.repeat(33))
    await expect(readBoundedResponseText(tooLarge, 32)).rejects.toBeInstanceOf(BoundedResponseError)
  })

  it('aborts stalled fetch/body work at the request deadline', async () => {
    const trace = createRequestTrace()
    trace.deadlineAt = Date.now() + 15
    let receivedSignal: AbortSignal | undefined
    const fakeFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      receivedSignal = init?.signal ?? undefined
      receivedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const operation = requestBoundFetch(trace, fakeFetch)('https://provider.test')
    await expect(withinRequestDeadline(trace, operation)).rejects.toMatchObject({ name: 'RequestDeadlineError' })
    expect(trace.controller.signal.aborted).toBe(true)
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('rejects a provider body that stalls after successful response headers', async () => {
    const controller = new AbortController()
    const timeout = AbortSignal.timeout(15)
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode('{"partial":')) },
      cancel() { controller.abort() },
    }))
    await expect(readBoundedResponseText(response, 100, timeout)).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(controller.signal.aborted).toBe(true)
  })

  it('keeps concurrent traces separate and exposes only safe operational fields', () => {
    const one = createRequestTrace()
    const two = createRequestTrace()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    one.provider = 'gemini'
    one.recordCount = 12
    setRequestStage(one, 'provider')
    one.status = 504
    logRequestTrace(one)
    const response = addRequestTrace(new Response('{}', { status: 504 }), one.id)

    expect(one.id).not.toBe(two.id)
    expect(response.headers.get('X-APMS-Request-ID')).toBe(one.id)
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-APMS-Request-ID')
    const entries = info.mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(entries.map((entry) => entry.request_id)).toEqual([one.id, one.id])
    expect(entries[0]).toMatchObject({ stage: 'provider', provider: 'gemini', record_count: 12 })
    expect(JSON.stringify(entries)).not.toMatch(/student|class_id|enrollment|authorization|api.key|secret/i)
  })

  it('maps upstream failures to fixed codes and preserves only numeric HTTP status', () => {
    expect(safeAIServiceFailure(new AIServiceError('upstream_error', 401))).toEqual({ status: 502, code: 'provider_authentication_failed', upstreamStatus: 401 })
    expect(safeAIServiceFailure(new AIServiceError('upstream_error', 403)).code).toBe('provider_authentication_failed')
    expect(safeAIServiceFailure(new AIServiceError('upstream_error', 422)).code).toBe('provider_request_rejected')
    expect(safeAIServiceFailure(new AIServiceError('upstream_error', 429)).code).toBe('provider_busy')
    expect(safeAIServiceFailure(new AIServiceError('upstream_error', 503)).code).toBe('provider_unavailable')
    expect(safeAIServiceFailure(new AIServiceError('upstream_error')).code).toBe('provider_connection_failed')
    expect(safeAIServiceFailure(new AIServiceError('response_too_large')).code).toBe('invalid_response')
    const raw = new Error('https://provider.test/private/path?token=never-log student=opaque')
    expect(safeAIServiceFailure(raw)).toEqual({ status: 502, code: 'provider_unavailable' })
    expect(JSON.stringify(safeAIServiceFailure(raw))).not.toMatch(/provider\.test|token=|student=/i)
  })

  it('keeps request abort connected through response-body consumption', async () => {
    const trace = createRequestTrace()
    let bodyCanceled = false
    const fakeFetch: typeof fetch = async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start() {},
      cancel() { bodyCanceled = true },
    }), { headers: { 'content-type': 'application/json' } })
    const response = await requestBoundFetch(trace, fakeFetch)('https://provider.test')
    const reading = readBoundedResponseText(response, 100, trace.controller.signal)
    trace.controller.abort()
    await expect(reading).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(bodyCanceled).toBe(true)
  })
})
