// TEST ONLY. Builds AppContexts and drives the Google and Meta connect flows
// against the fakes in tests/fixtures/.
import type { AppContext } from '../../src/lib/api.ts';
import type { AppConfig } from '../../src/lib/config.ts';
import { googleCallback, startGoogleConnect } from '../../src/lib/google-ads/service.ts';
import { metaCallback, startMetaConnect } from '../../src/lib/meta-ads/service.ts';
import {
  FIXTURE_API_VERSION, FIXTURE_CLIENT_ID, FIXTURE_CLIENT_SECRET, FIXTURE_TOKEN_KEY, type FakeGoogle,
} from '../fixtures/google.ts';
import { FIXTURE_META_APP_ID, FIXTURE_META_APP_SECRET, type FakeMeta } from '../fixtures/meta.ts';

export const ORIGIN = 'https://openads.example.test';
export const ADMIN = 'admin@example.test';
export const SECOND_ADMIN = 'second-admin@example.test';
export const MEMBER = 'member@example.test';

export function testEnv(db: D1Database, overrides: Partial<Record<string, string>> = {}): AppConfig {
  return {
    DB: db,
    PUBLIC_ORIGIN: ORIGIN,
    OPENADS_ADMIN_EMAILS: `${ADMIN},${SECOND_ADMIN}`,
    GOOGLE_OAUTH_CLIENT_ID: FIXTURE_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: FIXTURE_CLIENT_SECRET,
    GOOGLE_API_VERSION: FIXTURE_API_VERSION,
    TOKEN_ENCRYPTION_KEY: FIXTURE_TOKEN_KEY,
    META_APP_ID: FIXTURE_META_APP_ID,
    META_APP_SECRET: FIXTURE_META_APP_SECRET,
    ...overrides,
  };
}

export function context(env: AppConfig, email: string, fetcher: typeof fetch, now = () => Date.now()): AppContext {
  return { env, identity: { email, subject: `subject-${email}` }, fetcher, now };
}

export function post(path: string, init: { origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

export async function startUrl(ctx: AppContext): Promise<string> {
  const response = await startGoogleConnect(post('/api/oauth/google/start'), ctx);
  if (response.status !== 200) throw new Error(`start failed: ${response.status}`);
  const body = await response.json() as { authorizationUrl: string };
  return body.authorizationUrl;
}

/** Start → Google consent ("Allow") → callback. Returns the callback redirect. */
export async function connectGoogle(ctx: AppContext, google: FakeGoogle): Promise<Response> {
  const callback = google.approve(await startUrl(ctx));
  return googleCallback(new Request(callback), ctx);
}

export const location = (response: Response) => response.headers.get('Location');

export async function startMetaUrl(ctx: AppContext, body?: unknown): Promise<string> {
  const response = await startMetaConnect(post('/api/oauth/meta/start', { body }), ctx);
  if (response.status !== 200) throw new Error(`start failed: ${response.status}`);
  const result = await response.json() as { authorizationUrl: string };
  return result.authorizationUrl;
}

/** Start → Facebook dialog ("Continue") → callback. Returns the callback redirect. */
export async function connectMeta(ctx: AppContext, meta: FakeMeta, choice: { adsRead?: boolean } = {}): Promise<Response> {
  const callback = meta.approve(await startMetaUrl(ctx), choice);
  return metaCallback(new Request(callback), ctx);
}

/** One fetcher answering for both fakes (by host). */
export function providerFetch(google: { fetch: typeof fetch }, meta: { fetch: typeof fetch }): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'graph.facebook.com' ? meta.fetch(input, init) : google.fetch(input, init);
  };
}
