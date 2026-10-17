import { Container, getContainer } from '@cloudflare/containers';

export interface Env extends Cloudflare.Env {
  APMS_AI_SERVICE_API_KEY: string;
  APMS_AI_ARTIFACT_TOKEN?: string;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BEARER_CHARS = 1024;
const CONTAINER_NAME = 'apms-forecast';

type RemoteArtifactEnvironment = {
  APMS_AI_ARTIFACT_ENDPOINT?: string;
  APMS_AI_ARTIFACT_TOKEN?: string;
  APMS_AI_ARTIFACT_MANIFEST_SHA256?: string;
  APMS_AI_ARTIFACT_CACHE_DIR?: string;
};

export function artifactModeEnvironment(env: RemoteArtifactEnvironment) {
  const endpoint = env.APMS_AI_ARTIFACT_ENDPOINT?.trim() ?? '';
  if (!endpoint) return { enableInternet: false, envVars: {} as Record<string, string> };
  return {
    enableInternet: true,
    envVars: {
      APMS_AI_ARTIFACT_ENDPOINT: endpoint,
      APMS_AI_ARTIFACT_TOKEN: env.APMS_AI_ARTIFACT_TOKEN?.trim() ?? '',
      APMS_AI_ARTIFACT_MANIFEST_SHA256: env.APMS_AI_ARTIFACT_MANIFEST_SHA256?.trim() ?? '',
      APMS_AI_ARTIFACT_CACHE_DIR: env.APMS_AI_ARTIFACT_CACHE_DIR?.trim() || '/tmp/apms-model-cache',
    },
  };
}

export class APMSContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';
  private artifactEnv = this.env as unknown as RemoteArtifactEnvironment;
  enableInternet = artifactModeEnvironment(this.artifactEnv).enableInternet;
  envVars = {
    APMS_AI_SERVICE_API_KEY: this.env.APMS_AI_SERVICE_API_KEY?.trim() ?? '',
    APMS_MODEL_ARTIFACT_PATH: this.env.APMS_MODEL_ARTIFACT_PATH || '/models/active',
    APMS_AI_ENABLE_SYNTHETIC_DEMO: this.env.APMS_AI_ENABLE_SYNTHETIC_DEMO || 'false',
    OMP_NUM_THREADS: '1',
    OPENBLAS_NUM_THREADS: '1',
    ...artifactModeEnvironment(this.artifactEnv).envVars,
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hasValidBearer(request: Request, expectedKey: string): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const bounded = supplied.length > 0 && supplied.length <= MAX_BEARER_CHARS ? supplied : '';
  const normalizedKey = expectedKey.trim();
  const [expectedHash, suppliedHash] = await Promise.all([sha256(normalizedKey), sha256(bounded)]);
  let mismatch = normalizedKey.length === 0 || supplied.length === 0 || supplied.length > MAX_BEARER_CHARS ? 1 : 0;
  for (let index = 0; index < 32; index += 1) mismatch |= expectedHash[index] ^ suppliedHash[index];
  return mismatch === 0;
}

async function readBodyWithinLimit(request: Request): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isAllowedRoute(method: string, pathname: string, hasQuery: boolean): boolean {
  if (hasQuery) return false;
  return (method === 'POST' && pathname === '/v1/predictions')
    || (method === 'GET' && pathname === '/v1/status');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!isAllowedRoute(request.method, url.pathname, url.search.length > 0)) return jsonError(404, 'Not found');

    if (!await hasValidBearer(request, env.APMS_AI_SERVICE_API_KEY ?? '')) {
      return jsonError(401, 'Unauthorized');
    }

    const body = request.method === 'POST' ? await readBodyWithinLimit(request) : undefined;
    if (body === null) return jsonError(413, 'Request body too large');

    try {
      const headers = new Headers({
        authorization: request.headers.get('authorization') ?? '',
        accept: request.headers.get('accept') ?? 'application/json',
      });
      const contentType = request.headers.get('content-type');
      if (contentType) headers.set('content-type', contentType);
      const bodyBuffer = body === undefined ? undefined : new ArrayBuffer(body.byteLength);
      if (body !== undefined && bodyBuffer) new Uint8Array(bodyBuffer).set(body);
      const upstreamRequest = new Request(`http://container${url.pathname}`, {
        method: request.method,
        headers,
        ...(bodyBuffer === undefined ? {} : { body: bodyBuffer }),
      });

      const container = getContainer<APMSContainer>(env.AI_CONTAINER, CONTAINER_NAME);
      const upstream = await container.fetch(upstreamRequest);
      if (upstream.status >= 300 && upstream.status < 400) return jsonError(503, 'Service unavailable');
      const responseHeaders = new Headers({ 'cache-control': 'no-store' });
      for (const name of ['content-type', 'x-apms-artifact-id', 'x-apms-model-version']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch {
      return jsonError(503, 'Service unavailable');
    }
  },
} satisfies ExportedHandler<Env>;
