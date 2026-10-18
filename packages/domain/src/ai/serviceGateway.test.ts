import { describe, expect, it, vi } from 'vitest'
import {
  AIServiceError,
  createAIServiceConnector,
  createAIServiceStatusHandler,
  finalizeCustomServiceUsage,
  reserveCustomServiceUsage,
  readAIServiceConfiguration,
  safeAIServiceFailure,
} from '../../../../supabase/functions/_shared/aiService'

function configuration(overrides: Record<string, unknown> = {}) {
  return readAIServiceConfiguration({
    url: 'https://ai.example.test/prefix/',
    apiKey: 'server-only-token',
    cfAccessClientId: 'cloudflare-id',
    cfAccessClientSecret: 'cloudflare-secret',
    ...overrides,
  })
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const artifactId = 'deadbeef'.repeat(8)

describe('private AI service gateway', () => {
  it('requires HTTPS except explicitly enabled localhost development and rejects unsafe URL forms', () => {
    expect(() => readAIServiceConfiguration({ url: 'http://localhost:8080', apiKey: 'secret' })).toThrow(AIServiceError)
    expect(readAIServiceConfiguration({
      url: 'http://localhost:8080', apiKey: 'secret', allowInsecureHttp: true,
    }).transport).toBe('http_insecure')
    expect(() => readAIServiceConfiguration({
      url: 'http://public.example.test', apiKey: 'secret', allowInsecureHttp: true,
    })).toThrow(AIServiceError)
    for (const url of [
      'https://user:password@ai.example.test',
      'https://ai.example.test?token=secret',
      'https://ai.example.test/#fragment',
      'https://ai.example.test/base/../admin',
    ]) {
      expect(() => readAIServiceConfiguration({ url, apiKey: 'secret' })).toThrow(AIServiceError)
    }
    expect(() => readAIServiceConfiguration({
      url: 'https://ai.example.test',
      apiKey: 'secret',
      cfAccessClientId: 'id-only',
    })).toThrow(AIServiceError)
  })

  it('sends only server credentials and Cloudflare service-token headers to the configured base path', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse({ record_id: 'opaque-1', predicted_standing: 73 })
    }) as typeof fetch
    const connector = createAIServiceConnector(configuration(), fetcher)
    await expect(connector.predictOne({ record_id: 'opaque-1' })).resolves.toEqual({
      record_id: 'opaque-1',
      predicted_standing: 73,
    })
    expect(capturedUrl).toBe('https://ai.example.test/prefix/v1/predictions')
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('Authorization')).toBe('Bearer server-only-token')
    expect(headers.get('CF-Access-Client-Id')).toBe('cloudflare-id')
    expect(headers.get('CF-Access-Client-Secret')).toBe('cloudflare-secret')
    expect(capturedInit?.redirect).toBe('manual')
  })

  it('rejects redirects, non-JSON, malformed JSON, and oversized responses without following them', async () => {
    const redirect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example.test/collect' },
    })) as typeof fetch
    const redirectConnector = createAIServiceConnector(configuration(), redirect)
    await expect(redirectConnector.predictOne({})).rejects.toMatchObject({ code: 'upstream_error', status: 302 })
    expect(redirect).toHaveBeenCalledTimes(1)

    const nonJson = createAIServiceConnector(configuration(), vi.fn(async () => new Response('text', {
      headers: { 'Content-Type': 'text/plain' },
    })) as typeof fetch)
    await expect(nonJson.predictOne({})).rejects.toMatchObject({ code: 'invalid_response' })

    const malformed = createAIServiceConnector(configuration(), vi.fn(async () => new Response('{', {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch)
    await expect(malformed.predictOne({})).rejects.toMatchObject({ code: 'invalid_response' })

    const oversized = createAIServiceConnector(configuration({ maxResponseBytes: 8 }), vi.fn(async () => new Response('{"large":true}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '14' },
    })) as typeof fetch)
    await expect(oversized.predictOne({})).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('keeps upstream HTTP status while dropping private error bodies and credentials', async () => {
    for (const [status, code] of [
      [401, 'provider_authentication_failed'],
      [403, 'provider_authentication_failed'],
      [422, 'provider_request_rejected'],
      [429, 'provider_busy'],
      [503, 'provider_unavailable'],
    ] as const) {
      const connector = createAIServiceConnector(configuration(), vi.fn(async () => new Response(
        JSON.stringify({ error: 'private provider payload includes student=record-123 secret=provider-key' }),
        { status, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch)
      let caught: unknown
      try { await connector.probe() } catch (error) { caught = error }
      const safe = safeAIServiceFailure(caught)
      expect(safe).toEqual({ status: 502, code, upstreamStatus: status })
      expect(JSON.stringify(safe)).not.toMatch(/private provider|record-123|provider-key|student=|secret=/i)
    }

    const networkFailure = safeAIServiceFailure(new AIServiceError('upstream_error'))
    expect(networkFailure).toEqual({ status: 502, code: 'provider_connection_failed' })
    expect(safeAIServiceFailure(new AIServiceError('timeout')).code).toBe('provider_timeout')
    expect(safeAIServiceFailure(new AIServiceError('response_too_large')).code).toBe('invalid_response')
  })

  it('classifies an abort or never-ending body after HTTP 200 as a provider timeout', async () => {
    let stalledCancelCalled = false
    const stalled = createAIServiceConnector(configuration({ requestTimeoutMs: 100 }), vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"ready":true')) },
        cancel() {
          stalledCancelCalled = true
          // Simulate a transport whose cleanup promise never settles.
          return new Promise<void>(() => undefined)
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch)
    let stalledError: unknown
    try { await stalled.probe() } catch (error) { stalledError = error }
    expect(stalledError).toMatchObject({ code: 'timeout' })
    expect(safeAIServiceFailure(stalledError)).toEqual({ status: 504, code: 'provider_timeout' })
    expect(stalledCancelCalled).toBe(true)

    const abortedBody = createAIServiceConnector(configuration({ requestTimeoutMs: 1_000 }), vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ready":'))
          setTimeout(() => controller.error(new DOMException('opaque transport detail', 'AbortError')), 1)
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch)
    let abortError: unknown
    try { await abortedBody.probe() } catch (error) { abortError = error }
    expect(abortError).toMatchObject({ code: 'timeout' })
    expect(safeAIServiceFailure(abortError)).toEqual({ status: 504, code: 'provider_timeout' })
    expect(JSON.stringify(safeAIServiceFailure(abortError))).not.toContain('opaque transport detail')
  })

  it('enforces request bytes, per-request deadlines, and one overall batch deadline', async () => {
    const tooSmall = createAIServiceConnector(configuration({ maxRequestBytes: 4 }), vi.fn() as typeof fetch)
    await expect(tooSmall.predictOne({ too: 'large' })).rejects.toMatchObject({ code: 'request_too_large' })

    let time = 0
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      time = 100
      return jsonResponse({ record_id: 'opaque' })
    }) as typeof fetch
    const batch = createAIServiceConnector(
      configuration({ batchTimeoutMs: 100, requestTimeoutMs: 1_000 }),
      fetcher,
      () => time,
    )
    await expect(batch.predictBatch([{}, {}])).rejects.toMatchObject({ code: 'timeout' })
    expect(calls).toBe(1)

    const abort = createAIServiceConnector(configuration(), vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch)
    await expect(abort.predictOne({})).rejects.toMatchObject({ code: 'timeout' })
  })

  it('sanitizes worker status to an allowlist and never reports institutional validation', async () => {
    let time = 10
    const fetcher = vi.fn(async () => {
      time = 23
      return jsonResponse({
        ready: true,
        model_version: 'model-7-deadbeef1234',
        artifact_id: artifactId,
        artifact_source: 'supabase_storage',
        manifest_sha256: 'b'.repeat(64),
        device: 'cpu',
        synthetic_demo: false,
        institutionally_validated: true,
        capabilities: { v1_predictions: true, v2_forecasts: true, admin_path: '/private' },
        config: { api_key: 'must-not-escape' },
        artifact_source_url: 'https://must-not-escape',
      })
    }) as typeof fetch
    const probe = await createAIServiceConnector(configuration(), fetcher, () => time).probe()
    expect(probe).toEqual({
      reachable: true,
      ready: true,
      model_version: 'model-7-deadbeef1234',
      artifact_id: artifactId,
      artifact_source: 'supabase_storage',
      manifest_sha256: 'b'.repeat(64),
      device: 'cpu',
      synthetic_demo: false,
      institutionally_validated: false,
      capabilities: { v1_predictions: true, v2_forecasts: true, partial_assessment_inventory: false },
      latency_ms: 13,
    })
    expect(JSON.stringify(probe)).not.toContain('must-not-escape')
  })

  it('rejects prediction responses from a different worker artifact after probing', async () => {
    const status = {
      ready: true,
      model_version: 'model-7-deadbeef1234',
      artifact_id: artifactId,
      device: 'cpu',
      synthetic_demo: false,
      capabilities: { v1_predictions: true, v2_forecasts: true },
    }
    const start = (predictionHeaders: Record<string, string>) => {
      let calls = 0
      const fetcher = vi.fn(async () => {
        calls += 1
        return calls === 1
          ? jsonResponse(status)
          : new Response(JSON.stringify({ record_id: 'opaque-1' }), {
            headers: { 'Content-Type': 'application/json', ...predictionHeaders },
          })
      }) as typeof fetch
      return createAIServiceConnector(configuration(), fetcher)
    }

    const absentHeaders = start({})
    await absentHeaders.probe()
    await expect(absentHeaders.predictOne({ record_id: 'opaque-1' })).rejects.toMatchObject({ code: 'invalid_response' })

    const rolledOver = start({
      'X-APMS-Artifact-ID': 'a'.repeat(64),
      'X-APMS-Model-Version': 'model-7-deadbeef1234',
    })
    await rolledOver.probe()
    await expect(rolledOver.predictOne({ record_id: 'opaque-1' })).rejects.toMatchObject({ code: 'invalid_response' })

    const matching = start({
      'X-APMS-Artifact-ID': artifactId,
      'X-APMS-Model-Version': 'model-7-deadbeef1234',
    })
    await matching.probe()
    await expect(matching.predictOne({ record_id: 'opaque-1' })).resolves.toEqual({ record_id: 'opaque-1' })
  })

  it('rejects a ready worker status without a full content-addressed artifact id', async () => {
    const connector = createAIServiceConnector(configuration(), vi.fn(async () => jsonResponse({
      ready: true,
      model_version: 'model-7',
      artifact_id: 'deadbeef',
      synthetic_demo: false,
    })) as typeof fetch)
    await expect(connector.probe()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('does not read configuration or contact the service for unauthorized status callers', async () => {
    const fetcher = vi.fn()
    for (const [status, error] of [[401, 'Authentication required'], [403, 'System Administrator access is required']] as const) {
      const configurationReader = vi.fn(() => ({ value: configuration(), valid: true }))
      const handler = createAIServiceStatusHandler({
        authorize: async () => ({ allowed: false, status, error }),
        configuration: configurationReader,
        privacySettings: async () => ({ ai_enabled: false, assessment_data_enabled: false, attendance_data_enabled: false }),
        fetcher: fetcher as typeof fetch,
      })
      const response = await handler(new Request('https://edge.example.test/ai-service-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }))
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error })
      expect(configurationReader).not.toHaveBeenCalled()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reserves custom-service request counts before use and records success only after the caller finishes', async () => {
    const rpc = vi.fn(async () => ({ data: 'reservation-1', error: null }))
    const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }))
    const client = { rpc, from: vi.fn(() => ({ update })) }
    await expect(reserveCustomServiceUsage(client, {
      actorId: 'actor-1', classRecordId: 'class-1', model: 'worker-v1', requestCount: 3,
    })).resolves.toEqual({ status: 'reserved', id: 'reservation-1' })
    expect(rpc).toHaveBeenCalledWith('ai_custom_reserve_usage', {
      p_actor_id: 'actor-1', p_class_record_id: 'class-1', p_model: 'worker-v1', p_request_count: 3,
    })
    expect(update).not.toHaveBeenCalled()
    expect(await finalizeCustomServiceUsage(client, 'reservation-1')).toBe(true)
    expect(client.from).toHaveBeenCalledWith('ai_model_usage')
    expect(update).toHaveBeenCalledWith({ succeeded: true })

    await expect(reserveCustomServiceUsage({
      rpc: vi.fn(async () => ({ data: null, error: null })), from: client.from,
    }, { actorId: 'a', classRecordId: 'c', model: 'm', requestCount: 1 })).resolves.toEqual({ status: 'limit' })
    await expect(reserveCustomServiceUsage({
      rpc: vi.fn(async () => ({ data: null, error: new Error('database unavailable') })), from: client.from,
    }, { actorId: 'a', classRecordId: 'c', model: 'm', requestCount: 1 })).resolves.toEqual({ status: 'unavailable' })
  })
})
