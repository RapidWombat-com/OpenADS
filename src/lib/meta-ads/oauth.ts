// Facebook Login (manual, server-side code flow) for Meta Ads, with the
// operator's own Meta app. Tokens are returned to the caller only; nothing here
// logs or echoes them.
// https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow/
// https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived/
import { isRecord } from '../providers/http.ts';
import type { Fetcher } from '../providers/types.ts';
import { META_SCOPE } from './config.ts';
import { graphRequest, graphUrl, MetaGraphError, type GraphErrorKind } from './graph.ts';

export const FACEBOOK_DIALOG_ORIGIN = 'https://www.facebook.com';
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const TOKEN = /^[A-Za-z0-9._~+/=|-]{20,4096}$/;

export type MetaOAuthErrorCode =
  | 'invalid_app' | 'redirect_mismatch' | 'invalid_code' | 'invalid_token' | 'invalid_response' | 'upstream';

/** A fixed reason code; never carries a provider message or body. */
export class MetaOAuthError extends Error {
  readonly code: MetaOAuthErrorCode;
  constructor(code: MetaOAuthErrorCode) {
    super(`Meta OAuth: ${code}`);
    this.name = 'MetaOAuthError';
    this.code = code;
  }
}

function oauthError(error: unknown): MetaOAuthError {
  if (error instanceof MetaOAuthError) return error;
  const kind: GraphErrorKind | null = error instanceof MetaGraphError ? error.kind : null;
  return new MetaOAuthError(kind === 'app' ? 'invalid_app' : kind === 'redirect_uri' ? 'redirect_mismatch'
    : kind === 'code' ? 'invalid_code' : kind === 'token' ? 'invalid_token' : 'upstream');
}

/**
 * The Login dialog URL: `ads_read` only, authorization code in the query.
 * `rerequest` asks again for a permission the person declined before (Meta's
 * dialog otherwise skips it).
 */
export function authorizationUrl(input: {
  appId: string; redirectUri: string; state: string; version: string; rerequest?: boolean;
}): string {
  const url = new URL(`${FACEBOOK_DIALOG_ORIGIN}/${input.version}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: input.appId,
    redirect_uri: input.redirectUri,
    state: input.state,
    scope: META_SCOPE,
    response_type: 'code',
    ...(input.rerequest ? { auth_type: 'rerequest' } : {}),
  }).toString();
  return url.toString();
}

const timeout = () => AbortSignal.timeout(TIMEOUT_MS);

function accessToken(body: Record<string, unknown>): { token: string; expiresIn: number | null } {
  if (typeof body.access_token !== 'string' || !TOKEN.test(body.access_token)
    || (body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'))
    || (body.expires_in !== undefined && (typeof body.expires_in !== 'number'
      || !Number.isSafeInteger(body.expires_in) || body.expires_in < 0))) {
    throw new MetaOAuthError('invalid_response');
  }
  return { token: body.access_token, expiresIn: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : null };
}

/** Code → short-lived user token (server to server; the App Secret never leaves the Worker). */
export async function exchangeCode(input: {
  appId: string; appSecret: string; redirectUri: string; code: string; version: string;
}, fetcher: Fetcher): Promise<string> {
  try {
    // POST form body: the App Secret and the code never appear in a URL.
    const body = await graphRequest(fetcher, graphUrl(input.version, '/oauth/access_token'), {
      method: 'POST',
      form: { client_id: input.appId, redirect_uri: input.redirectUri, client_secret: input.appSecret, code: input.code },
      maxBytes: MAX_TOKEN_RESPONSE_BYTES, signal: timeout(), oauthEndpoint: true,
    });
    return accessToken(body).token;
  } catch (error) {
    throw oauthError(error);
  }
}

/** Short-lived → long-lived user token (about 60 days); `expiresIn` in seconds when Meta says. */
export async function exchangeLongLived(input: {
  appId: string; appSecret: string; token: string; version: string;
}, fetcher: Fetcher): Promise<{ token: string; expiresIn: number | null }> {
  try {
    // POST form body: the App Secret and the short-lived token never appear in a URL.
    const body = await graphRequest(fetcher, graphUrl(input.version, '/oauth/access_token'), {
      method: 'POST',
      form: { grant_type: 'fb_exchange_token', client_id: input.appId, client_secret: input.appSecret, fb_exchange_token: input.token },
      maxBytes: MAX_TOKEN_RESPONSE_BYTES, signal: timeout(), oauthEndpoint: true,
    });
    return accessToken(body);
  } catch (error) {
    throw oauthError(error);
  }
}

export interface TokenInfo {
  /** App-scoped user ID the token belongs to. */
  readonly userId: string;
  /** Epoch ms; null when Meta reports no expiry (0). */
  readonly expiresAt: number | null;
  /** Epoch ms after which data access ends even if the token is still valid; null when unknown. */
  readonly dataAccessExpiresAt: number | null;
}

const epoch = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value * 1000 : null;

/**
 * `debug_token` with the app access token (Bearer header): the token must be valid, of type
 * USER, and issued to *this* app (a token minted for another app is refused).
 * Only ever called with the short-lived token of the code exchange (see
 * completeLogin): the long-lived token that OpenADS stores is never put in a URL.
 */
export async function inspectToken(input: {
  appId: string; appSecret: string; token: string; version: string;
}, fetcher: Fetcher): Promise<TokenInfo> {
  let body: Record<string, unknown>;
  try {
    // The app access token goes in the Authorization header, not the URL. Meta
    // documents debug_token as GET only (input_token as a query parameter; there is
    // no documented POST or header form), so the inspected token must be in the
    // query. That is why only the short-lived token (about an hour, never stored)
    // is inspected. It is passed as `secretQuery`: only a private copy of the URL handed to
    // the fetcher carries it (over TLS to the fixed Graph host). That URL is never
    // logged, stored, returned or put in an error: graphRequest throws fixed-message
    // MetaGraphErrors only, a rejected fetch is replaced by one (redactedFetch), and
    // oauthError maps everything to a MetaOAuthError code. tests/meta-oauth.test.ts
    // checks that no failure path exposes the token.
    body = await graphRequest(fetcher, graphUrl(input.version, '/debug_token'), {
      appToken: `${input.appId}|${input.appSecret}`, secretQuery: { input_token: input.token },
      maxBytes: MAX_TOKEN_RESPONSE_BYTES, signal: timeout(), oauthEndpoint: true,
    });
  } catch (error) {
    throw oauthError(error);
  }
  const data = isRecord(body.data) ? body.data : null;
  const userId = data && (typeof data.user_id === 'string' || typeof data.user_id === 'number') ? String(data.user_id) : null;
  if (!data || data.is_valid !== true || String(data.app_id) !== input.appId
    || (data.type !== undefined && data.type !== 'USER') || !userId || !/^\d{1,32}$/.test(userId)) {
    throw new MetaOAuthError('invalid_token');
  }
  return { userId, expiresAt: epoch(data.expires_at), dataAccessExpiresAt: epoch(data.data_access_expires_at) };
}

/** The permissions the person granted and declined (`/me/permissions`). */
export async function permissions(input: {
  appSecret: string; token: string; version: string;
}, fetcher: Fetcher): Promise<{ granted: Set<string>; declined: Set<string> }> {
  let body: Record<string, unknown>;
  try {
    body = await graphRequest(fetcher, graphUrl(input.version, '/me/permissions'), {
      accessToken: input.token, appSecret: input.appSecret, maxBytes: MAX_TOKEN_RESPONSE_BYTES, signal: timeout(),
    });
  } catch (error) {
    throw oauthError(error);
  }
  if (!Array.isArray(body.data) || body.data.length > 500) throw new MetaOAuthError('invalid_response');
  const granted = new Set<string>();
  const declined = new Set<string>();
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.permission !== 'string') throw new MetaOAuthError('invalid_response');
    if (item.status === 'granted') granted.add(item.permission);
    else declined.add(item.permission);
  }
  return { granted, declined };
}

/** The connected Facebook user: `/me?fields=id,name`. */
export async function profile(input: {
  appSecret: string; token: string; version: string;
}, fetcher: Fetcher): Promise<{ id: string; name: string | null }> {
  let body: Record<string, unknown>;
  try {
    body = await graphRequest(fetcher, graphUrl(input.version, '/me', { fields: 'id,name' }), {
      accessToken: input.token, appSecret: input.appSecret, maxBytes: MAX_TOKEN_RESPONSE_BYTES, signal: timeout(),
    });
  } catch (error) {
    throw oauthError(error);
  }
  if (typeof body.id !== 'string' || !/^\d{1,32}$/.test(body.id)) throw new MetaOAuthError('invalid_response');
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 256) : null;
  return { id: body.id, name };
}

export interface MetaGrant {
  readonly token: string;
  readonly userId: string;
  readonly name: string | null;
  /** min(token expiry, data-access expiry) in epoch ms; null when Meta reports neither. */
  readonly expiresAt: number | null;
  /** False when the person did not grant `ads_read`. */
  readonly adsRead: boolean;
}

/**
 * The whole callback exchange: code → short-lived token → `debug_token` on the
 * short-lived token (issued to this app, for a user) → long-lived token →
 * `/me/permissions` and `/me` (Bearer header). The long-lived token is never put
 * in a URL: its expiry comes from the exchange response (`expires_in`), the
 * data-access expiry (per user and app, not per token) from `debug_token`.
 */
export async function completeLogin(input: {
  appId: string; appSecret: string; redirectUri: string; code: string; version: string;
}, fetcher: Fetcher, now = Date.now()): Promise<MetaGrant> {
  const short = await exchangeCode(input, fetcher);
  const info = await inspectToken({ appId: input.appId, appSecret: input.appSecret, token: short, version: input.version }, fetcher);
  const long = await exchangeLongLived({ appId: input.appId, appSecret: input.appSecret, token: short, version: input.version }, fetcher);
  const auth = { appSecret: input.appSecret, token: long.token, version: input.version };
  const granted = await permissions(auth, fetcher);
  const me = await profile(auth, fetcher);
  // The long-lived token belongs to the same user the inspected short-lived token did.
  if (me.id !== info.userId) throw new MetaOAuthError('invalid_token');
  const candidates = [long.expiresIn ? now + long.expiresIn * 1000 : null, info.dataAccessExpiresAt]
    .filter((value): value is number => value !== null);
  return {
    token: long.token, userId: info.userId, name: me.name,
    expiresAt: candidates.length ? Math.min(...candidates) : null,
    adsRead: granted.granted.has(META_SCOPE),
  };
}

/**
 * Best-effort deauthorization: `DELETE /me/permissions` removes the app's whole
 * login for this person. True when Meta confirmed it.
 */
export async function revokePermissions(input: {
  appSecret: string; token: string; version: string;
}, fetcher: Fetcher): Promise<boolean> {
  try {
    const body = await graphRequest(fetcher, graphUrl(input.version, '/me/permissions'), {
      method: 'DELETE', accessToken: input.token, appSecret: input.appSecret, maxBytes: 4096, signal: AbortSignal.timeout(5_000),
    });
    return body.success === true;
  } catch {
    return false;
  }
}
