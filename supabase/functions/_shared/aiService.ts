export type AIServiceEnvironment = {
  url?: string
  apiKey?: string
  model?: string
  modelVersion?: string
  cfAccessClientId?: string
  cfAccessClientSecret?: string
  allowInsecureHttp?: boolean
  requestTimeoutMs?: number
  batchTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
}

export type AIServiceConfiguration = {
  configured: boolean
  url: URL | null
  apiKey: string | null
  model: string | null
  modelVersion: string | null
  cfAccessClientId: string | null
  cfAccessClientSecret: string | null
  transport: 'https' | 'http_insecure' | 'unconfigured'
  maxRequestBytes: number
  maxResponseBytes: number
  requestTimeoutMs: number
  batchTimeoutMs: number
}

export class AIServiceError extends Error {
  readonly code: 'unconfigured' | 'invalid_configuration' | 'request_too_large' | 'response_too_large' | 'upstream_error' | 'invalid_response' | 'timeout'
  readonly status?: number

  constructor(code: AIServiceError['code'], status?: number) {
    super(code)
    this.name = 'AIServiceError'
    this.code = code
    this.status = status
  }
}

export type SafeAIServiceFailure = {
  status: 413 | 502 | 504
  code: 'provider_authentication_failed' | 'provider_request_rejected' | 'provider_busy' | 'provider_unavailable' | 'provider_connection_failed' | 'provider_timeout' | 'invalid_response' | 'request_too_large'
  upstreamStatus?: number
}

/** Convert connector failures to a fixed, non-sensitive public diagnostic. */
export function safeAIServiceFailure(error: unknown): SafeAIServiceFailure {
  if (!(error instanceof AIServiceError)) {
    return { status: 502, code: 'provider_unavailable' }
  }
  if (error.code === 'timeout') return { status: 504, code: 'provider_timeout' }
  if (error.code === 'request_too_large') return { status: 413, code: 'request_too_large' }
  if (error.code === 'invalid_response' || error.code === 'response_too_large') {
    return { status: 502, code: 'invalid_response' }
  }
  if (error.code === 'upstream_error') {
    const upstreamStatus = Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? error.status : undefined
    const code = upstreamStatus === 401 || upstreamStatus === 403
      ? 'provider_authentication_failed'
      : upstreamStatus === 422
        ? 'provider_request_rejected'
        : upstreamStatus === 429
          ? 'provider_busy'
          : upstreamStatus === undefined
            ? 'provider_connection_failed'
            : 'provider_unavailable'
    return { status: 502, code, ...(upstreamStatus === undefined ? {} : { upstreamStatus }) }
  }
  return { status: 502, code: 'provider_unavailable' }
}

export type CustomUsageClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string) => PromiseLike<{ error: unknown }>
    }
  }
}

export type CustomUsageReservation =
  | { status: 'reserved'; id: string }
  | { status: 'limit' }
  | { status: 'unavailable' }

export async function reserveCustomServiceUsage(
  client: CustomUsageClient,
  input: { actorId: string; classRecordId: string; model: string; requestCount: number },
): Promise<CustomUsageReservation> {
  try {
    const { data, error } = await client.rpc('ai_custom_reserve_usage', {
      p_actor_id: input.actorId,
      p_class_record_id: input.classRecordId,
      p_model: input.model,
      p_request_count: input.requestCount,
    })
    if (error) return { status: 'unavailable' }
    if (typeof data !== 'string' || !data) return { status: 'limit' }
    return { status: 'reserved', id: data }
  } catch {
    return { status: 'unavailable' }
  }
}

export async function finalizeCustomServiceUsage(client: CustomUsageClient, reservationId: string): Promise<boolean> {
  try {
    const { error } = await client.from('ai_model_usage').update({ succeeded: true }).eq('id', reservationId)
    return !error
  } catch {
    return false
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_BATCH_TIMEOUT_MS = 45_000
const DEFAULT_MAX_REQUEST_BYTES = 700_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback
}

function checkedBaseUrl(raw: string, allowInsecureHttp: boolean): URL {
  if (raw.includes('?') || raw.includes('#')) throw new AIServiceError('invalid_configuration')
  const rawPath = raw.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] ?? ''
  try {
    if (decodeURIComponent(rawPath).split('/').some((part) => part === '.' || part === '..')) {
      throw new AIServiceError('invalid_configuration')
    }
  } catch {
    throw new AIServiceError('invalid_configuration')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AIServiceError('invalid_configuration')
  }
  if (url.username || url.password || url.search || url.hash || !url.hostname) {
    throw new AIServiceError('invalid_configuration')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AIServiceError('invalid_configuration')
  }
  if (url.protocol === 'http:') {
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal'].includes(url.hostname.toLowerCase())
    if (!allowInsecureHttp || !loopback) throw new AIServiceError('invalid_configuration')
  }
  const decodedPath = decodeURIComponent(url.pathname)
  if (decodedPath.split('/').some((part) => part === '.' || part === '..')) {
    throw new AIServiceError('invalid_configuration')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

export function readAIServiceConfiguration(environment: AIServiceEnvironment): AIServiceConfiguration {
  const urlText = environment.url?.trim() ?? ''
  const apiKey = environment.apiKey?.trim() ?? ''
  const clientId = environment.cfAccessClientId?.trim() ?? ''
  const clientSecret = environment.cfAccessClientSecret?.trim() ?? ''
  const requestTimeoutMs = boundedInteger(environment.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 100, 60_000)
  const batchTimeoutMs = boundedInteger(environment.batchTimeoutMs, DEFAULT_BATCH_TIMEOUT_MS, 100, 120_000)
  const maxRequestBytes = boundedInteger(environment.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1, 1_000_000)
  const maxResponseBytes = boundedInteger(environment.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, 2_000_000)
  if (!!clientId !== !!clientSecret) throw new AIServiceError('invalid_configuration')
  if (!urlText || !apiKey) {
    return {
      configured: false,
      url: null,
      apiKey: null,
      model: environment.model?.trim() || null,
      modelVersion: environment.modelVersion?.trim() || null,
      cfAccessClientId: clientId || null,
      cfAccessClientSecret: clientSecret || null,
      transport: 'unconfigured',
      maxRequestBytes,
      maxResponseBytes,
      requestTimeoutMs,
      batchTimeoutMs,
    }
  }
  const url = checkedBaseUrl(urlText, environment.allowInsecureHttp === true)
  return {
    configured: true,
    url,
    apiKey,
    model: environment.model?.trim() || null,
    modelVersion: environment.modelVersion?.trim() || null,
    cfAccessClientId: clientId || null,
    cfAccessClientSecret: clientSecret || null,
    transport: url.protocol === 'https:' ? 'https' : 'http_insecure',
    maxRequestBytes,
    maxResponseBytes,
    requestTimeoutMs,
    batchTimeoutMs,
  }
}

export function aiServiceConfigurationFromEnvironment(getEnv: (name: string) => string | undefined): AIServiceConfiguration {
  return readAIServiceConfiguration({
    url: getEnv('APMS_AI_SERVICE_URL'),
    apiKey: getEnv('APMS_AI_SERVICE_API_KEY'),
    model: getEnv('APMS_AI_SERVICE_MODEL'),
    modelVersion: getEnv('APMS_AI_SERVICE_MODEL_VERSION'),
    cfAccessClientId: getEnv('APMS_AI_CF_ACCESS_CLIENT_ID'),
    cfAccessClientSecret: getEnv('APMS_AI_CF_ACCESS_CLIENT_SECRET'),
    allowInsecureHttp: getEnv('APMS_AI_ALLOW_INSECURE_HTTP') === 'true',
  })
}

type WorkerStatus = {
  reachable: boolean
  ready: boolean
  model_version: string | null
  artifact_id: string | null
  artifact_source: 'local' | 'supabase_storage' | 'unavailable'
  manifest_sha256: string | null
  device: string | null
  synthetic_demo: boolean
  institutionally_validated: false
  capabilities: { v1_predictions: boolean; v2_forecasts: boolean; partial_assessment_inventory: boolean }
}

export type AIServiceProbe = WorkerStatus & { latency_ms: number }

function safeText(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' && value.length <= maximumLength ? value : null
}

function sanitizeWorkerStatus(value: unknown): Omit<WorkerStatus, 'reachable'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AIServiceError('invalid_response')
  const body = value as Record<string, unknown>
  const capabilities = body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)
    ? body.capabilities as Record<string, unknown>
    : {}
  if (typeof body.ready !== 'boolean' || typeof body.synthetic_demo !== 'boolean') {
    throw new AIServiceError('invalid_response')
  }
  const artifactId = safeText(body.artifact_id, 120)
  const modelVersion = safeText(body.model_version, 120)
  if (body.ready && (!artifactId || !/^[a-f0-9]{64}$/i.test(artifactId) || !modelVersion)) {
    throw new AIServiceError('invalid_response')
  }
  return {
    ready: body.ready,
    model_version: modelVersion,
    artifact_id: artifactId,
    artifact_source: body.artifact_source === 'local' || body.artifact_source === 'supabase_storage'
      ? body.artifact_source
      : 'unavailable',
    manifest_sha256: typeof body.manifest_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(body.manifest_sha256)
      ? body.manifest_sha256.toLowerCase()
      : null,
    device: safeText(body.device, 50),
    synthetic_demo: body.synthetic_demo,
    // The service contract never lets a health response claim validation.
    institutionally_validated: false,
    capabilities: {
      v1_predictions: capabilities.v1_predictions === true,
      v2_forecasts: capabilities.v2_forecasts === true,
      partial_assessment_inventory: capabilities.partial_assessment_inventory === true,
    },
  }
}

async function readBoundedJson(response: Response, maximumBytes: number, signal: AbortSignal): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw new AIServiceError('response_too_large')
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
  if (!(contentType === 'application/json' || contentType.endsWith('+json'))) {
    void response.body?.cancel().catch(() => undefined)
    throw new AIServiceError('invalid_response')
  }
  if (!response.body) throw new AIServiceError('invalid_response')
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  let timeoutReject: (error: AIServiceError) => void = () => undefined
  const rejectTimeout = () => timeoutReject(new AIServiceError('timeout'))
  const timeout = new Promise<never>((_, reject) => {
    timeoutReject = reject
    if (signal.aborted) rejectTimeout()
    else signal.addEventListener('abort', rejectTimeout, { once: true })
  })
  try {
    while (true) {
      let item: ReadableStreamReadResult<Uint8Array>
      try { item = await Promise.race([reader.read(), timeout]) }
      catch (error) {
        if (error instanceof AIServiceError) throw error
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new AIServiceError('timeout')
        throw new AIServiceError('invalid_response')
      }
      if (signal.aborted) throw new AIServiceError('timeout')
      const { done, value } = item
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        cancel()
        throw new AIServiceError('response_too_large')
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    signal.removeEventListener('abort', rejectTimeout)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new AIServiceError('invalid_response')
  }
}

export function createAIServiceConnector(
  configuration: AIServiceConfiguration,
  fetcher: typeof fetch = fetch,
  now: () => number = () => performance.now(),
) {
  if (!configuration.configured || !configuration.url || !configuration.apiKey) {
    throw new AIServiceError('unconfigured')
  }
  const deadline = now() + configuration.batchTimeoutMs
  const endpoint = (path: string) => `${configuration.url!.toString().replace(/\/+$/, '')}${path}`
  // A load balancer can route successive requests to different worker releases.
  // Pin predictions to the exact artifact observed by this request's probe.
  let expectedWorkerIdentity: { artifactId: string; modelVersion: string } | null = null

  async function call(path: string, body?: unknown): Promise<unknown> {
    const remaining = deadline - now()
    if (remaining <= 0) throw new AIServiceError('timeout')
    const requestBody = body === undefined ? undefined : JSON.stringify(body)
    if (requestBody && new TextEncoder().encode(requestBody).byteLength > configuration.maxRequestBytes) {
      throw new AIServiceError('request_too_large')
    }
    const timeoutMs = Math.max(1, Math.min(configuration.requestTimeoutMs, remaining))
    const requestTimeout = AbortSignal.timeout(timeoutMs)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${configuration.apiKey}`,
      Accept: 'application/json',
    }
    if (requestBody !== undefined) headers['Content-Type'] = 'application/json'
    if (configuration.cfAccessClientId && configuration.cfAccessClientSecret) {
      headers['CF-Access-Client-Id'] = configuration.cfAccessClientId
      headers['CF-Access-Client-Secret'] = configuration.cfAccessClientSecret
    }
    let response: Response
    try {
      response = await fetcher(endpoint(path), {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: requestBody,
        redirect: 'manual',
        signal: requestTimeout,
      })
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new AIServiceError('timeout')
      }
      throw new AIServiceError('upstream_error')
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined)
      throw new AIServiceError('upstream_error', response.status)
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new AIServiceError('upstream_error', response.status)
    }
    if (path === '/v1/predictions' && expectedWorkerIdentity) {
      const artifactId = response.headers.get('X-APMS-Artifact-ID')
      const modelVersion = response.headers.get('X-APMS-Model-Version')
      if (artifactId !== expectedWorkerIdentity.artifactId || modelVersion !== expectedWorkerIdentity.modelVersion) {
        void response.body?.cancel().catch(() => undefined)
        throw new AIServiceError('invalid_response')
      }
    }
    return await readBoundedJson(response, configuration.maxResponseBytes, requestTimeout)
  }

  async function predictOne(payload: unknown): Promise<Record<string, unknown>> {
    const result = await call('/v1/predictions', payload)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AIServiceError('invalid_response')
    return result as Record<string, unknown>
  }

  return {
    predictOne,
    async predictBatch(payloads: unknown[]): Promise<Record<string, unknown>[]> {
      const results: Record<string, unknown>[] = []
      for (const payload of payloads) results.push(await predictOne(payload))
      return results
    },
    async probe(): Promise<AIServiceProbe> {
      const startedAt = now()
      const status = sanitizeWorkerStatus(await call('/v1/status'))
      expectedWorkerIdentity = status.ready && status.model_version && status.artifact_id
        ? { artifactId: status.artifact_id, modelVersion: status.model_version }
        : null
      return { reachable: true, ...status, latency_ms: Math.max(0, Math.round(now() - startedAt)) }
    },
  }
}

export function failedAIServiceProbe(): AIServiceProbe {
  return {
    reachable: false,
    ready: false,
    model_version: null,
    artifact_id: null,
    artifact_source: 'unavailable',
    manifest_sha256: null,
    device: null,
    synthetic_demo: false,
    institutionally_validated: false,
    capabilities: { v1_predictions: false, v2_forecasts: false, partial_assessment_inventory: false },
    latency_ms: 0,
  }
}

export type AIServiceStatusAuthorization = {
  allowed: boolean
  status?: 401 | 403 | 503
  error?: string
}

export function createAIServiceStatusHandler(dependencies: {
  authorize: (request: Request) => Promise<AIServiceStatusAuthorization>
  configuration: () => { value: AIServiceConfiguration; valid: boolean; model?: string }
  privacySettings: () => Promise<{ ai_enabled: boolean; assessment_data_enabled: boolean; attendance_data_enabled: boolean }>
  fetcher?: typeof fetch
}) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  })
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    const authorization = await dependencies.authorize(request)
    if (!authorization.allowed) return json({ error: authorization.error ?? 'Access denied' }, authorization.status ?? 403)

    let config: ReturnType<typeof dependencies.configuration>
    try {
      config = dependencies.configuration()
    } catch {
      config = {
        value: readAIServiceConfiguration({}),
        valid: false,
      }
    }
    if (request.method === 'GET') {
      let requestPrivacy: Awaited<ReturnType<typeof dependencies.privacySettings>>
      try {
        requestPrivacy = await dependencies.privacySettings()
      } catch {
        return json({ error: 'AI privacy settings could not be loaded' }, 503)
      }
      return json({
        configured: config.valid && config.value.configured,
        model: config.value.model ?? config.model?.trim() ?? null,
        transport: config.valid ? config.value.transport : 'unconfigured',
        cloudflare_access_configured: config.valid && !!config.value.cfAccessClientId && !!config.value.cfAccessClientSecret,
        configuration_valid: config.valid,
        request_privacy: requestPrivacy,
      })
    }

    let body: unknown
    try {
      const declaredLength = Number(request.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > 1_000) return json({ error: 'Probe request is too large' }, 413)
      const reader = request.body?.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (reader) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > 1_000) {
          await reader.cancel()
          return json({ error: 'Probe request is too large' }, 413)
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const text = new TextDecoder().decode(bytes)
      body = text ? JSON.parse(text) : {}
    } catch {
      return json({ error: 'Invalid probe request' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
      return json({ error: 'Probe requests do not accept URL or payload overrides' }, 400)
    }
    if (!config.valid || !config.value.configured) {
      return json({ probe: failedAIServiceProbe(), error: 'AI service is not configured' }, 503)
    }
    try {
      const probe = await createAIServiceConnector(config.value, dependencies.fetcher).probe()
      return json({ probe })
    } catch {
      return json({ probe: failedAIServiceProbe(), error: 'AI service probe failed' }, 502)
    }
  }
}
