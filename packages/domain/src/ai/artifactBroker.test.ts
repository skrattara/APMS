import { describe, expect, it, vi } from 'vitest'
import {
  createArtifactBrokerHandler,
  createBoundedStorageFetch,
  type ArtifactStorage,
} from '../../../../supabase/functions/_shared/artifactBroker'

const machineToken = 'a-long-random-artifact-broker-token-for-tests'
const releasePrefix = 'releases/model-v7'
const allowedPaths = [
  'weights.pt',
  'metadata.json',
  'schemas/grading_system_schema.json',
  'schemas/evaluation_system_schema.json',
]

async function sha256Hex(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function manifest(files: Array<Record<string, unknown>> = allowedPaths.map((path) => ({
  path,
  sha256: 'a'.repeat(64),
  size_bytes: 1,
}))) {
  return JSON.stringify({ format: 'apms-inference-manifest-v1', files })
}

async function makeHarness(options: {
  rawManifest?: string
  manifestHash?: string
  bucketPublic?: boolean
  signedPaths?: (paths: string[]) => Array<{ path: string; signedUrl: string }>
} = {}) {
  const rawManifest = options.rawManifest ?? manifest()
  const values: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-service-role-key',
    APMS_AI_ARTIFACT_TOKEN: machineToken,
    APMS_AI_ARTIFACT_BUCKET: 'apms-ai-artifacts',
    APMS_AI_ARTIFACT_PREFIX: releasePrefix,
    APMS_AI_ARTIFACT_MANIFEST_SHA256: options.manifestHash ?? await sha256Hex(rawManifest),
  }
  const paths: string[][] = []
  const lifetimes: number[] = []
  const storage: ArtifactStorage = {
    getBucket: vi.fn(async () => ({ data: { public: options.bucketPublic ?? false }, error: null })),
    from: vi.fn(() => ({
      download: vi.fn(async (path: string) => ({ data: new Blob([rawManifest]), error: null })),
      createSignedUrls: vi.fn(async (signedPaths: string[], expiresIn: number) => {
        paths.push(signedPaths)
        lifetimes.push(expiresIn)
        return {
          data: options.signedPaths?.(signedPaths) ?? signedPaths.map((path) => ({ path, signedUrl: `https://project.supabase.co/storage/v1/object/sign/apms-ai-artifacts/${path}?token=temporary` })),
          error: null,
        }
      }),
    })),
  }
  const createStorage = vi.fn(() => storage)
  const handler = createArtifactBrokerHandler({
    getEnvironment: (name) => values[name],
    createStorage,
  })
  return { handler, createStorage, storage, paths, lifetimes, values, rawManifest }
}

function request(method = 'GET', token = machineToken) {
  return new Request('https://edge.example.test/ai-model-artifact', {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

describe('machine-authenticated model artifact broker', () => {
  it('checks the bearer token before creating a Supabase client or contacting Storage', async () => {
    const harness = await makeHarness()
    const response = await harness.handler(request('GET', 'incorrect-machine-token-that-is-long-enough'))
    expect(response.status).toBe(401)
    expect(harness.createStorage).not.toHaveBeenCalled()
    expect(harness.storage.getBucket).not.toHaveBeenCalled()
  })

  it('only serves GET requests', async () => {
    const harness = await makeHarness()
    const response = await harness.handler(request('POST'))
    expect(response.status).toBe(405)
    expect(harness.createStorage).not.toHaveBeenCalled()
  })

  it('rejects query overrides before opening a Storage client', async () => {
    const harness = await makeHarness()
    const response = await harness.handler(new Request('https://edge.example.test/ai-model-artifact?prefix=attacker'))
    expect(response.status).toBe(400)
    expect(harness.createStorage).not.toHaveBeenCalled()
  })

  it('verifies the pinned raw manifest and signs only four allowlisted objects for ten minutes', async () => {
    const harness = await makeHarness()
    const response = await harness.handler(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    const body = await response.json()
    expect(body.manifest_json).toBe(harness.rawManifest)
    expect(body.downloads.map((file: { path: string }) => file.path)).toEqual(allowedPaths)
    expect(harness.paths).toEqual([allowedPaths.map((path) => `${releasePrefix}/${path}`)])
    expect(harness.lifetimes).toEqual([600])
    expect(harness.storage.getBucket).toHaveBeenCalledWith('apms-ai-artifacts')
  })

  it('rejects public buckets and manifest hash mismatches without signing files', async () => {
    const publicBucket = await makeHarness({ bucketPublic: true })
    expect((await publicBucket.handler(request())).status).toBe(503)
    expect(publicBucket.storage.from).not.toHaveBeenCalled()

    const badHash = await makeHarness({ manifestHash: '0'.repeat(64) })
    expect((await badHash.handler(request())).status).toBe(503)
    expect(badHash.paths).toHaveLength(0)
  })

  it('rejects nonallowlisted, duplicate, missing, and oversized manifest entries', async () => {
    const cases = [
      allowedPaths.map((path, index) => ({ path: index === 0 ? 'arbitrary.txt' : path, sha256: 'a'.repeat(64), size_bytes: 1 })),
      allowedPaths.map((path, index) => ({ path: index === 1 ? 'weights.pt' : path, sha256: 'a'.repeat(64), size_bytes: 1 })),
      allowedPaths.slice(0, 3).map((path) => ({ path, sha256: 'a'.repeat(64), size_bytes: 1 })),
      allowedPaths.map((path) => ({ path, sha256: 'a'.repeat(64), size_bytes: path === 'weights.pt' ? 512 * 1024 * 1024 + 1 : 1 })),
      allowedPaths.map((path) => ({ path, sha256: 'a'.repeat(64), size_bytes: 512 * 1024 * 1024 })),
    ]
    for (const files of cases) {
      const harness = await makeHarness({ rawManifest: manifest(files) })
      expect((await harness.handler(request())).status).toBe(503)
      expect(harness.paths).toHaveLength(0)
    }
  })

  it('rejects signed-url responses that contain unrequested or duplicate paths', async () => {
    const harness = await makeHarness({
      signedPaths: (paths) => paths.map((path, index) => ({
        path: index === 0 ? 'releases/other/weights.pt' : path,
        signedUrl: 'https://project.supabase.co/storage/v1/object/sign/not-allowed',
      })),
    })
    expect((await harness.handler(request())).status).toBe(503)
  })

  it('bounds streamed manifest bytes before returning a response to the Storage SDK', async () => {
    const boundedFetch = createBoundedStorageFetch(
      'https://project.supabase.co',
      'apms-ai-artifacts',
      releasePrefix,
      async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(40 * 1024))
          controller.enqueue(new Uint8Array(40 * 1024))
          controller.close()
        },
      }), { headers: { 'Content-Type': 'application/json' } }),
    )
    await expect(boundedFetch('https://project.supabase.co/storage/v1/object/authenticated/apms-ai-artifacts/releases/model-v7/manifest.json'))
      .rejects.toThrow('storage_response_too_large')
  })

  it('applies a per-request abort deadline and rejects redirects', async () => {
    const slowFetch = createBoundedStorageFetch(
      'https://project.supabase.co', 'apms-ai-artifacts', releasePrefix,
      (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
      { requestTimeoutMs: 5, totalTimeoutMs: 100 },
    )
    await expect(slowFetch('https://project.supabase.co/storage/v1/bucket/apms-ai-artifacts'))
      .rejects.toThrow('storage_request_failed')

    const redirectFetch = createBoundedStorageFetch(
      'https://project.supabase.co', 'apms-ai-artifacts', releasePrefix,
      async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example/file' } }),
    )
    await expect(redirectFetch('https://project.supabase.co/storage/v1/bucket/apms-ai-artifacts'))
      .rejects.toThrow('storage_redirect_rejected')
  })
})
