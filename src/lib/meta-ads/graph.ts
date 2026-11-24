// Read-only Graph API transport for Meta Ads: fixed host, manual redirects,
// bounded bodies, `appsecret_proof` on every call made with a user token, and
// error classification from Meta's numeric codes only (messages, fbtrace_id and
// every other field of an error body are ignored and never surfaced).
// https://developers.facebook.com/documentation/facebook-login/security/#proof
import { discard, isRecord, readJson, REDIRECT_MODE, successful } from '../providers/http.ts';
import type { Fetcher } from '../providers/types.ts';

export const GRAPH_ORIGIN = 'https://graph.facebook.com';
const MAX_ERROR_BYTES = 64 * 1024;
const encoder = new TextEncoder();

/**
 * `appsecret_proof`: lowercase hex HMAC-SHA256 of the access token, keyed with
 * the App Secret. Proves the call comes from a server holding the secret (and
 * works when "Require App Secret" is on in the App Dashboard).
 */
export async function appSecretProof(accessToken: string, appSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(accessToken)));
  return [...mac].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What a Graph error means for OpenADS:
 * - `token`: the user token is invalid or expired (code 190/102) → reconnect;
 * - `app`: the App ID or App Secret is wrong (code 101, or 1 on the OAuth endpoint) → setup;
 * - `redirect_uri`: the redirect URI does not match the dialog's (code 100, subcode 36008);
 * - `code`: the authorization code is invalid, expired or used (code 100, subcodes 36007/36009);
 * - `permission`: a permission or account role is missing (code 10, 200–299);
 * - `rate_limit`: throttled (4, 17, 32, 613, 80000–80014);
 * - `other`: anything else, including transport failures.
 */
export type GraphErrorKind = 'token' | 'app' | 'redirect_uri' | 'code' | 'permission' | 'rate_limit' | 'other';

export class MetaGraphError extends Error {
  readonly kind: GraphErrorKind;
  readonly code: number | null;
  constructor(kind: GraphErrorKind, code: number | null = null) {
    super(`Meta Graph API: ${kind}`);
    this.name = 'MetaGraphError';
    this.kind = kind;
    this.code = code;
  }
}

const RATE_LIMIT = new Set([4, 17, 32, 613]);

export function classifyGraphError(body: unknown, oauthEndpoint = false): MetaGraphError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = error && typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : null;
  const subcode = error && typeof error.error_subcode === 'number' ? error.error_subcode : null;
  if (code === 190 || code === 102) return new MetaGraphError('token', code);
  if (code === 101 || (code === 1 && oauthEndpoint)) return new MetaGraphError('app', code);
  if (code === 100 && subcode === 36008) return new MetaGraphError('redirect_uri', code);
  if (code === 100 && (subcode === 36007 || subcode === 36009)) return new MetaGraphError('code', code);
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return new MetaGraphError('permission', code);
  if (code !== null && (RATE_LIMIT.has(code) || (code >= 80000 && code <= 80014))) return new MetaGraphError('rate_limit', code);
  return new MetaGraphError('other', code);
}

export interface GraphRequest {
  readonly method?: 'GET' | 'POST' | 'DELETE';
  /** User access token: sent as a Bearer header (never in the URL) with its appsecret_proof. */
  readonly accessToken?: string;
  readonly appSecret?: string;
  /**
   * App access token (`app_id|app_secret`): sent as a Bearer header, never in the
   * URL. No appsecret_proof (that proves possession of the secret for user tokens).
   */
  readonly appToken?: string;
  /** Parameters sent as an application/x-www-form-urlencoded POST body (never in the URL). */
  readonly form?: Readonly<Record<string, string>>;
  /**
   * Credentials a GET-only endpoint takes only as query parameters (`input_token`
   * of `debug_token`). Added to a private copy of the URL that is handed to the
   * fetcher and nothing else: the caller's URL never carries them, and no error,
   * log line or return value ever includes that copy (see redactedFetch).
   */
  readonly secretQuery?: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  /** The OAuth token endpoint, where code 1 means a wrong App Secret. */
  readonly oauthEndpoint?: boolean;
}

/** Query parameters that carry credentials: never allowed in a Graph URL. */
const SECRET_PARAMS = ['access_token', 'client_secret', 'fb_exchange_token', 'code', 'input_token'] as const;

/** Credential query parameters a request may carry through `secretQuery`. */
const SECRET_QUERY_PARAMS = new Set(['input_token']);

/**
 * Fetch whose failure can never carry the URL: a rejected fetch (whose message,
 * cause or stack may include the URL with a credential in its query) becomes a
 * fixed MetaGraphError with no cause. The Response is used only for its status
 * and body here; its `url` is never read.
 */
export async function redactedFetch(fetcher: Fetcher, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch {
    throw new MetaGraphError('other');
  }
}

/**
 * One Graph API call on the fixed host. Returns the JSON object of a direct 2xx
 * response; throws MetaGraphError otherwise. Only a direct 4xx JSON body is read,
 * and only for its numeric `code`/`error_subcode`. Credentials travel only in the
 * Authorization header or a POST body; a URL carrying one is refused before any
 * request, and no error ever includes the URL, a header or a body.
 */
export async function graphRequest(fetcher: Fetcher, url: URL, request: GraphRequest): Promise<Record<string, unknown>> {
  if (url.origin !== GRAPH_ORIGIN || SECRET_PARAMS.some(name => url.searchParams.has(name))) throw new MetaGraphError('other');
  if ((request.form !== undefined) !== (request.method === 'POST') || (request.accessToken && request.appToken)) {
    throw new MetaGraphError('other');
  }
  if (request.secretQuery && ((request.method ?? 'GET') !== 'GET'
    || Object.keys(request.secretQuery).some(name => !SECRET_QUERY_PARAMS.has(name)))) {
    throw new MetaGraphError('other');
  }
  request.signal.throwIfAborted();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (request.accessToken) {
    if (!request.appSecret) throw new MetaGraphError('other');
    headers.Authorization = `Bearer ${request.accessToken}`;
    url.searchParams.set('appsecret_proof', await appSecretProof(request.accessToken, request.appSecret));
  } else if (request.appToken) {
    headers.Authorization = `Bearer ${request.appToken}`;
  }
  let body: string | undefined;
  if (request.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(request.form).toString();
  }
  let target = url;
  if (request.secretQuery) {
    target = new URL(url);
    for (const [name, value] of Object.entries(request.secretQuery)) target.searchParams.set(name, value);
  }
  const response = await redactedFetch(fetcher, target, {
    method: request.method ?? 'GET', headers, body, redirect: REDIRECT_MODE, signal: request.signal,
  });
  if (!successful(response)) {
    if (response.status >= 400 && response.status <= 499 && response.type !== 'opaqueredirect'
      && !response.redirected && response.body) {
      let error: unknown = null;
      try {
        error = await readJson(response as Response & { body: ReadableStream<Uint8Array> }, MAX_ERROR_BYTES, request.signal);
      } catch {
        // Unreadable error body: generic failure below.
      }
      throw classifyGraphError(error, request.oauthEndpoint);
    }
    discard(response);
    throw new MetaGraphError('other');
  }
  let result: unknown;
  try {
    result = await readJson(response, request.maxBytes, request.signal);
  } catch {
    throw new MetaGraphError('other');
  }
  if (!isRecord(result)) throw new MetaGraphError('other');
  // Graph can answer 200 with an error object; treat it like an error response.
  if ('error' in result) throw classifyGraphError(result, request.oauthEndpoint);
  return result;
}

/** A Graph URL on the fixed host for an API version and a path of fixed segments (`/` for `?ids=` lookups). */
export function graphUrl(version: string, path: string, params: Record<string, string> = {}): URL {
  if (!/^v\d{1,3}\.\d{1,2}$/.test(version) || !/^\/[A-Za-z0-9_/]*$/.test(path)) throw new MetaGraphError('other');
  const url = new URL(`${GRAPH_ORIGIN}/${version}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/**
 * Opaque `after` cursor of a Graph page: only the cursor is reused, on our own
 * fixed URL; provider-supplied `next` URLs are never requested. Null on the last page.
 */
export function nextCursor(body: Record<string, unknown>, seen: Set<string>): string | null {
  if (body.paging === undefined) return null;
  if (!isRecord(body.paging)) throw new MetaGraphError('other');
  if (body.paging.next === undefined) return null;
  if (typeof body.paging.next !== 'string' || !body.paging.next) throw new MetaGraphError('other');
  const cursor = isRecord(body.paging.cursors) ? body.paging.cursors.after : undefined;
  if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || seen.has(cursor)) throw new MetaGraphError('other');
  seen.add(cursor);
  return cursor;
}
