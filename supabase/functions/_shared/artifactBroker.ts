const MANIFEST_LIMIT_BYTES = 64 * 1024
const FILE_LIMIT_BYTES = 512 * 1024 * 1024
const RELEASE_TOTAL_LIMIT_BYTES = 1024 * 1024 * 1024
const SIGNED_URL_LIFETIME_SECONDS = 600
const ALLOWED_ARTIFACT_PATHS = new Set([
  'weights.pt',
  'metadata.json',
  'schemas/grading_system_schema.json',
  'schemas/evaluation_system_schema.json',
])

const STORAGE_REQUEST_LIMIT_MS = 15_000
const STORAGE_TOTAL_LIMIT_MS = 45_000
const STORAGE_JSON_LIMIT_BYTES = 128 * 1024

/**
 * Bound every response before Supabase Storage can turn it into a Blob. This
 * keeps a compromised or misconfigured bucket from buffering a huge object in
 * the Edge Function's memory. The broker only ever calls the Storage REST API.
 */
export function createBoundedStorageFetch(
  serviceUrl: string,
  bucket: string,
  prefix: string,
  fetcher: typeof fetch = fetch,
  limits: { requestTimeoutMs?: number; totalTimeoutMs?: number } = {},
) {
  const base = new URL(serviceUrl)
  const overallLimitMs = limits.totalTimeoutMs ?? STORAGE_TOTAL_LIMIT_MS
  const requestLimitMs = limits.requestTimeoutMs ?? STORAGE_REQUEST_LIMIT_MS
  const deadline = Date.now() + overallLimitMs

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), base)
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/storage/v1/`)) {
      throw new Error('storage_request_rejected')
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new Error('storage_deadline_exceeded')

    const timeout = AbortSignal.timeout(Math.max(1, Math.min(requestLimitMs, remainingMs)))
    const inputSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = inputSignal ? AbortSignal.any([inputSignal, timeout]) : timeout
    let response: Response
    try {
      response = await fetcher(input, { ...init, redirect: 'manual', signal })
    } catch {
      throw new Error('storage_request_failed')
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error('storage_redirect_rejected')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('storage_response_rejected')
    }

    const decodedPath = (() => { try { return decodeURIComponent(url.pathname) } catch { return url.pathname } })()
    const manifestSuffix = `/object/authenticated/${bucket}/${prefix}/manifest.json`
    const isManifest = decodedPath.endsWith(manifestSuffix)
    const isJson = (response.headers.get('content-type') ?? '').toLowerCase().includes('json')
    const limitBytes = isManifest ? 64 * 1024 : isJson ? STORAGE_JSON_LIMIT_BYTES : 64 * 1024
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
      await response.body?.cancel()
      throw new Error('storage_response_too_large')
    }

    const reader = response.body?.getReader()
    if (!reader) return new Response(null, { status: response.status, headers: response.headers })
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        if (Date.now() >= deadline) throw new Error('storage_deadline_exceeded')
        const item = await reader.read()
        if (item.done) break
        total += item.value.byteLength
        if (total > limitBytes) throw new Error('storage_response_too_large')
        chunks.push(item.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error instanceof Error && error.message.startsWith('storage_') ? error : new Error('storage_request_failed')
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new Response(bytes, { status: response.status, headers: response.headers })
  }
}

type ArtifactFile = { path: string; sha256: string; size_bytes: number }
type ArtifactManifest = { format: 'apms-inference-manifest-v1'; files: ArtifactFile[] }
type ArtifactConfiguration = {
  serviceUrl: string
  serviceRoleKey: string
  token: string
  bucket: string
  prefix: string
  manifestSha256: string
}

export type ArtifactStorage = {
  getBucket: (bucket: string) => Promise<{ data: { public?: boolean } | null; error: unknown }>
  from: (bucket: string) => {
    download: (path: string) => Promise<{ data: Blob | null; error: unknown }>
    createSignedUrls: (paths: string[], expiresIn: number) => Promise<{
      data: Array<{ path?: string; signedUrl?: string }> | null
      error: unknown
    }>
  }
}

export type ArtifactBrokerResult = {
  manifest_json: string
  downloads: Array<{ path: string; url: string }>
}

export function artifactBrokerConfigurationFromEnvironment(getEnv: (name: string) => string | undefined): ArtifactConfiguration {
  const serviceUrl = getEnv('SUPABASE_URL')?.trim() ?? ''
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? ''
  const token = getEnv('APMS_AI_ARTIFACT_TOKEN')?.trim() ?? ''
  const bucket = getEnv('APMS_AI_ARTIFACT_BUCKET')?.trim() || 'apms-ai-artifacts'
  const prefix = getEnv('APMS_AI_ARTIFACT_PREFIX')?.trim() ?? ''
  const manifestSha256 = getEnv('APMS_AI_ARTIFACT_MANIFEST_SHA256')?.trim().toLowerCase() ?? ''

  let parsedUrl: URL
  try { parsedUrl = new URL(serviceUrl) } catch { throw new Error('invalid_configuration') }
  const localHttp = parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)
  if ((!localHttp && parsedUrl.protocol !== 'https:') || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error('invalid_configuration')
  }
  if (!serviceRoleKey || token.length < 32 || token.length > 512) throw new Error('invalid_configuration')
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket)) throw new Error('invalid_configuration')
  if (!/^releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(prefix) || prefix.includes('..')) throw new Error('invalid_configuration')
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error('invalid_configuration')

  return { serviceUrl, serviceRoleKey, token, bucket, prefix, manifestSha256 }
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function constantTimeTokenMatches(supplied: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(suppliedHash)
  const right = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

function readManifest(raw: string): ArtifactManifest {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('invalid_manifest') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_manifest')
  const manifest = parsed as Record<string, unknown>
  if (Object.keys(manifest).length !== 2 || manifest.format !== 'apms-inference-manifest-v1' || !Array.isArray(manifest.files) || manifest.files.length !== ALLOWED_ARTIFACT_PATHS.size) {
    throw new Error('invalid_manifest')
  }

  const seen = new Set<string>()
  let totalBytes = 0
  const files: ArtifactFile[] = []
  for (const candidate of manifest.files) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid_manifest')
    const file = candidate as Record<string, unknown>
    if (Object.keys(file).length !== 3 || !('path' in file) || !('sha256' in file) || !('size_bytes' in file)) throw new Error('invalid_manifest')
    if (typeof file.path !== 'string' || !ALLOWED_ARTIFACT_PATHS.has(file.path) || seen.has(file.path)) throw new Error('invalid_manifest')
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('invalid_manifest')
    if (typeof file.size_bytes !== 'number' || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 1 || file.size_bytes > FILE_LIMIT_BYTES) throw new Error('invalid_manifest')
    seen.add(file.path)
    totalBytes += file.size_bytes
    if (totalBytes > RELEASE_TOTAL_LIMIT_BYTES) throw new Error('invalid_manifest')
    files.push({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes })
  }
  if (seen.size !== ALLOWED_ARTIFACT_PATHS.size) throw new Error('invalid_manifest')
  return { format: 'apms-inference-manifest-v1', files }
}

export async function authenticateArtifactRequest(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return false
  const supplied = authorization.slice('Bearer '.length)
  if (supplied.length < 32 || supplied.length > 512) return false
  return await constantTimeTokenMatches(supplied, expectedToken)
}

export async function brokerModelArtifacts(
  config: ArtifactConfiguration,
  storage: ArtifactStorage,
): Promise<ArtifactBrokerResult> {
  const bucketResult = await storage.getBucket(config.bucket)
  if (bucketResult.error || bucketResult.data?.public !== false) throw new Error('private_bucket_required')

  const storageBucket = storage.from(config.bucket)
  const manifestPath = `${config.prefix}/manifest.json`
  const manifestResult = await storageBucket.download(manifestPath)
  if (manifestResult.error || !manifestResult.data || manifestResult.data.size > MANIFEST_LIMIT_BYTES) throw new Error('manifest_unavailable')
  const bytes = new Uint8Array(await manifestResult.data.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MANIFEST_LIMIT_BYTES) throw new Error('manifest_unavailable')
  const actualHash = await sha256Hex(bytes)
  if (actualHash !== config.manifestSha256) throw new Error('manifest_hash_mismatch')

  let manifestJson: string
  try { manifestJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('invalid_manifest') }
  const manifest = readManifest(manifestJson)
  const objectPaths = manifest.files.map((file) => `${config.prefix}/${file.path}`)
  const signedResult = await storageBucket.createSignedUrls(objectPaths, SIGNED_URL_LIFETIME_SECONDS)
  if (signedResult.error || !Array.isArray(signedResult.data) || signedResult.data.length !== objectPaths.length) throw new Error('signing_failed')

  const signedByPath = new Map<string, string>()
  for (const signed of signedResult.data) {
    if (typeof signed.path !== 'string' || !objectPaths.includes(signed.path) || signedByPath.has(signed.path)) throw new Error('signing_failed')
    if (typeof signed.signedUrl !== 'string' || !signed.signedUrl) throw new Error('signing_failed')
    signedByPath.set(signed.path, signed.signedUrl)
  }
  if (signedByPath.size !== objectPaths.length) throw new Error('signing_failed')

  return {
    manifest_json: manifestJson,
    downloads: manifest.files.map((file) => ({
      path: file.path,
      url: signedByPath.get(`${config.prefix}/${file.path}`)!,
    })),
  }
}

export function createArtifactBrokerHandler(dependencies: {
  getEnvironment: (name: string) => string | undefined
  createStorage: (serviceUrl: string, serviceRoleKey: string) => ArtifactStorage
}) {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' },
  })
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

    if (new URL(request.url).search !== '') return json({ error: 'Query parameters are not supported' }, 400)
    const expectedToken = dependencies.getEnvironment('APMS_AI_ARTIFACT_TOKEN')?.trim() ?? ''
    if (expectedToken.length < 32 || expectedToken.length > 512 || !await authenticateArtifactRequest(request, expectedToken)) {
      return json({ error: 'Unauthorized' }, 401)
    }

    try {
      const config = artifactBrokerConfigurationFromEnvironment(dependencies.getEnvironment)
      const storage = dependencies.createStorage(config.serviceUrl, config.serviceRoleKey)
      const result = await brokerModelArtifacts(config, storage)
      return json(result, 200)
    } catch {
      return json({ error: 'Model artifacts are unavailable' }, 503)
    }
  }
}
