// Google OAuth 2.0 web-server flow for Google Ads (authorization code + PKCE).
// https://developers.google.com/identity/protocols/oauth2/web-server
// Tokens are returned to the caller only; nothing here logs or echoes them.
import { decodeJwt } from 'jose';
import { discard, isRecord, readJson, REDIRECT_MODE, successful } from '../providers/http.ts';
import type { Fetcher } from '../providers/types.ts';

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const GOOGLE_SCOPES = `${GOOGLE_ADS_SCOPE} openid email`;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

export type GoogleOAuthErrorCode =
  | 'invalid_grant' | 'invalid_client' | 'missing_refresh_token' | 'insufficient_scope' | 'invalid_response' | 'upstream';

/** A fixed reason code; never carries a provider message or body. */
export class GoogleOAuthError extends Error {
  readonly code: GoogleOAuthErrorCode;
  constructor(code: GoogleOAuthErrorCode) {
    super(`Google OAuth: ${code}`);
    this.name = 'GoogleOAuthError';
    this.code = code;
  }
}

export function authorizationUrl(input: {
  clientId: string; redirectUri: string; state: string; codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

function validToken(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && TOKEN.test(value);
}

/** POST to the token endpoint; returns the parsed body or a fixed error code. */
async function tokenRequest(
  params: Record<string, string>, fetcher: Fetcher, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      redirect: REDIRECT_MODE,
      signal: combined,
    });
  } catch {
    throw new GoogleOAuthError('upstream');
  }
  // Only a direct 400/401 error body is inspected, and only for its error code.
  if ((response.status === 400 || response.status === 401) && response.type !== 'opaqueredirect'
    && !response.redirected && response.body) {
    let code: unknown;
    try {
      const body = await readJson(response as Response & { body: ReadableStream<Uint8Array> }, MAX_TOKEN_RESPONSE_BYTES, combined);
      code = isRecord(body) ? body.error : undefined;
    } catch {
      // Unreadable error body: generic failure below.
    }
    // invalid_client / unauthorized_client: wrong client ID or secret (fix the
    // instance's OAuth client); invalid_grant: the user's grant is gone (reconnect).
    throw new GoogleOAuthError(code === 'invalid_grant' ? 'invalid_grant'
      : code === 'invalid_client' || code === 'unauthorized_client' ? 'invalid_client' : 'upstream');
  }
  if (!successful(response)) {
    discard(response);
    throw new GoogleOAuthError('upstream');
  }
  let body: unknown;
  try {
    body = await readJson(response, MAX_TOKEN_RESPONSE_BYTES, combined);
  } catch {
    throw new GoogleOAuthError('invalid_response');
  }
  if (!isRecord(body) || 'error' in body || !validToken(body.access_token)
    || (body.token_type !== undefined && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'))
    || (body.expires_in !== undefined && (typeof body.expires_in !== 'number'
      || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0))) {
    throw new GoogleOAuthError('invalid_response');
  }
  return body;
}

export interface CodeExchange {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly subject: string;
  readonly email: string | null;
}

/**
 * Exchanges an authorization code (with its PKCE verifier). Requires a refresh
 * token, the Google Ads scope and an ID token from Google for this client. The
 * ID token arrives directly from the token endpoint over TLS, so its issuer,
 * audience and expiry are checked without a JWKS signature check (OIDC Core 3.1.3.7).
 */
export async function exchangeCode(input: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string;
}, fetcher: Fetcher, now = Date.now()): Promise<CodeExchange> {
  const body = await tokenRequest({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, fetcher);
  const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/) : [];
  if (!scopes.includes(GOOGLE_ADS_SCOPE)) throw new GoogleOAuthError('insufficient_scope');
  if (body.refresh_token === undefined || body.refresh_token === '') throw new GoogleOAuthError('missing_refresh_token');
  if (!validToken(body.refresh_token, 2048)) throw new GoogleOAuthError('invalid_response');
  if (typeof body.id_token !== 'string' || body.id_token.length > 16_384) throw new GoogleOAuthError('invalid_response');
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(body.id_token);
  } catch {
    throw new GoogleOAuthError('invalid_response');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss) || !audience.includes(input.clientId)
    || (Array.isArray(claims.aud) && claims.azp !== input.clientId)
    || typeof claims.exp !== 'number' || claims.exp * 1000 <= now
    || typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) {
    throw new GoogleOAuthError('invalid_response');
  }
  const email = typeof claims.email === 'string' && claims.email_verified !== false
    && claims.email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(claims.email) ? claims.email : null;
  return { accessToken: body.access_token as string, refreshToken: body.refresh_token, subject: claims.sub, email };
}

/** A short-lived access token; GoogleOAuthError('invalid_grant') when the grant is revoked or expired. */
export async function refreshAccessToken(input: {
  clientId: string; clientSecret: string; refreshToken: string;
}, fetcher: Fetcher, signal?: AbortSignal): Promise<string> {
  const body = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, fetcher, signal);
  return body.access_token as string;
}

/** Best-effort revocation of the whole grant; true when Google confirmed it. */
export async function revokeGrant(token: string, fetcher: Fetcher): Promise<boolean> {
  try {
    const response = await fetcher(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      redirect: REDIRECT_MODE,
      signal: AbortSignal.timeout(5_000),
    });
    const ok = successful(response);
    discard(response);
    return ok;
  } catch {
    return false;
  }
}
