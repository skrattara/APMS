import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getContainerMock } = vi.hoisted(() => ({ getContainerMock: vi.fn() }));

vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  getContainer: getContainerMock,
}));

import { getContainer } from '@cloudflare/containers';
import worker, { artifactModeEnvironment, type Env } from './index';

const SERVICE_KEY = 'a-test-service-key-that-is-not-a-production-secret';

function testEnv(): Env {
  return {
    APMS_AI_SERVICE_API_KEY: `${SERVICE_KEY}\r\n`,
    APMS_MODEL_ARTIFACT_PATH: '/models/active',
    APMS_AI_ENABLE_SYNTHETIC_DEMO: 'false',
    APMS_AI_ARTIFACT_ENDPOINT: '',
    APMS_AI_ARTIFACT_MANIFEST_SHA256: '',
    APMS_AI_ARTIFACT_CACHE_DIR: '/tmp/apms-model-cache',
    AI_CONTAINER: {} as Env['AI_CONTAINER'],
  };
}

function invoke(request: Request, env = testEnv()) {
  return worker.fetch(request, env);
}

describe('Cloudflare gateway authorization and routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps artifact egress disabled for local artifacts and forwards remote credentials only in remote mode', () => {
    expect(artifactModeEnvironment({ APMS_AI_ARTIFACT_ENDPOINT: '  ' })).toEqual({ enableInternet: false, envVars: {} });
    expect(artifactModeEnvironment({
      APMS_AI_ARTIFACT_ENDPOINT: ' https://project.example/functions/v1/ai-model-artifact ',
      APMS_AI_ARTIFACT_TOKEN: ' artifact-token\r\n',
      APMS_AI_ARTIFACT_MANIFEST_SHA256: ` ${'a'.repeat(64)} `,
    })).toEqual({
      enableInternet: true,
      envVars: {
        APMS_AI_ARTIFACT_ENDPOINT: 'https://project.example/functions/v1/ai-model-artifact',
        APMS_AI_ARTIFACT_TOKEN: 'artifact-token',
        APMS_AI_ARTIFACT_MANIFEST_SHA256: 'a'.repeat(64),
        APMS_AI_ARTIFACT_CACHE_DIR: '/tmp/apms-model-cache',
      },
    });
  });

  it('rejects unauthorized callers before looking up or starting a container', async () => {
    const response = await invoke(new Request('https://worker.test/v1/status', {
      headers: { authorization: 'Bearer wrong-key' },
    }));

    expect(response.status).toBe(401);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('rejects non-allowlisted routes and methods without starting a container', async () => {
    const headers = { authorization: `Bearer ${SERVICE_KEY}` };
    const invalidMethod = await invoke(new Request('https://worker.test/v1/predictions', { method: 'GET', headers }));
    const invalidPath = await invoke(new Request('https://worker.test/container/anything', { headers }));
    const queryOverride = await invoke(new Request('https://worker.test/v1/status?target=elsewhere', { headers }));

    expect([invalidMethod.status, invalidPath.status, queryOverride.status]).toEqual([404, 404, 404]);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('caps the streamed request body before starting the container', async () => {
    const body = new Uint8Array(1024 * 1024 + 1);
    const response = await invoke(new Request('https://worker.test/v1/predictions', {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
      body,
    }));

    expect(response.status).toBe(413);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('forwards only the authenticated service bearer and allowed request headers', async () => {
    const containerFetch = vi.fn(async (_request: Request) => new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-apms-artifact-id': 'model-artifact-123',
        'x-apms-model-version': 'v2.4.1',
        'x-untrusted-upstream-header': 'must-not-forward',
        'cache-control': 'public, max-age=60',
      },
    }));
    getContainerMock.mockReturnValue({ fetch: containerFetch });
    const payload = JSON.stringify({ example: 'typed forecast' });
    const env = testEnv();
    const response = await invoke(new Request('https://worker.test/v1/predictions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_KEY}`,
        'content-type': 'application/json',
        cookie: 'user-session=must-not-forward',
        'x-user-id': 'student-123',
      },
      body: payload,
    }), env);

    expect(getContainer).toHaveBeenCalledTimes(1);
    expect(getContainer).toHaveBeenCalledWith(env.AI_CONTAINER, 'apms-forecast');
    const forwarded = containerFetch.mock.calls[0]?.[0];
    expect(forwarded).toBeInstanceOf(Request);
    expect(new URL(forwarded.url).pathname).toBe('/v1/predictions');
    expect(forwarded.headers.get('authorization')).toBe(`Bearer ${SERVICE_KEY}`);
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('x-user-id')).toBeNull();
    expect(await forwarded.text()).toBe(payload);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-apms-artifact-id')).toBe('model-artifact-123');
    expect(response.headers.get('x-apms-model-version')).toBe('v2.4.1');
    expect(response.headers.get('x-untrusted-upstream-header')).toBeNull();
    expect(response.status).toBe(200);
  });
});
