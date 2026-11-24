import { parseExactAddresses } from './access.ts';
import { importTokenKey, open, type TokenKey } from './crypto.ts';
import { getGoogleSetup } from './store.ts';

// Narrow, read-only views of the Worker environment. Every instance (self-host)
// brings its own values; nothing here is specific to one deployment. Secrets are
// Workers secret bindings; they are never logged, returned or sent anywhere but
// their provider.
export type AppConfig = Readonly<Partial<Record<
  | 'PUBLIC_ORIGIN' | 'OPENADS_ADMIN_EMAILS'
  | 'GOOGLE_OAUTH_CLIENT_ID' | 'GOOGLE_OAUTH_CLIENT_SECRET' | 'GOOGLE_API_VERSION' | 'GOOGLE_DEVELOPER_TOKEN'
  | 'TOKEN_ENCRYPTION_KEY'
  | 'META_APP_ID' | 'META_APP_SECRET' | 'META_API_VERSION' | 'META_CONVERSION_ACTION_TYPE', string>>>
  & { readonly DB?: D1Database };

/**
 * Google Ads API version used when GOOGLE_API_VERSION is not set. Pinned per
 * OpenADS release (v26: released 2026-10-14, sunset November 2027); an operator
 * may override it with a newer supported version.
 */
export const GOOGLE_ADS_API_VERSION = 'v26';
export const OAUTH_CALLBACK_PATH = '/api/oauth/google/callback';

/** A configured value that is safe to put in a header or form field. */
export function configuredText(value: string | undefined, maxLength = 16_384): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value.trim() === value && !/[\x00-\x20\x7f]/.test(value) ? value : null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1']);

/**
 * PUBLIC_ORIGIN: the exact public origin of this instance, used for the OAuth
 * redirect URI and same-origin checks; never derived from request headers.
 * `https://host[:port]` with a DNS host name (Google refuses raw IP hosts), or
 * plain HTTP only for local runs: `http://localhost:<port>` / `http://127.0.0.1:<port>`.
 */
export function publicOrigin(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length > 255) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) return null;
    if (url.protocol === 'https:') {
      const ip = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.startsWith('[');
      return ip || !url.hostname.includes('.') && !LOOPBACK.has(url.hostname) ? null : url.origin;
    }
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname) && url.port !== '') return url.origin;
  } catch {
    // Not a URL.
  }
  return null;
}

/** GOOGLE_API_VERSION when set (`v` plus digits), else the pinned default; null when malformed. */
export function googleApiVersion(value: string | undefined): string | null {
  if (value === undefined || value === '') return GOOGLE_ADS_API_VERSION;
  return /^v\d{1,4}$/.test(value) ? value : null;
}

/** Google OAuth Web client IDs end with `.apps.googleusercontent.com`. */
export function validClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 30 && value.length <= 255
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/.test(value);
}

export function validClientSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

/** Google Cloud project IDs: 6–30 lowercase letters, digits or hyphens, starting with a letter. */
export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

export type ClientSource = 'deployment' | 'instance';

export interface GoogleClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly source: ClientSource;
}

export interface InstanceStatus {
  readonly origin: string | null;
  readonly originState: 'ok' | 'missing' | 'invalid';
  readonly tokenKey: TokenKey | null;
  readonly keyState: 'ok' | 'missing' | 'invalid';
  readonly database: boolean;
  readonly version: string | null;
  /** GOOGLE_OAUTH_CLIENT_ID/SECRET in the deployment: none, both valid, or incomplete/malformed. */
  readonly deploymentClient: 'none' | 'ok' | 'invalid';
  readonly developerToken: string | null;
  readonly developerTokenState: 'none' | 'ok' | 'invalid';
}

/** Deploy-time prerequisites of the Google Ads connection, without touching D1. */
export async function instanceStatus(env: AppConfig): Promise<InstanceStatus> {
  const origin = publicOrigin(env.PUBLIC_ORIGIN);
  const tokenKey = env.TOKEN_ENCRYPTION_KEY ? await importTokenKey(env.TOKEN_ENCRYPTION_KEY) : null;
  const id = env.GOOGLE_OAUTH_CLIENT_ID ?? '';
  const secret = env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
  const developerToken = env.GOOGLE_DEVELOPER_TOKEN ? configuredText(env.GOOGLE_DEVELOPER_TOKEN, 512) : null;
  return {
    origin,
    originState: origin ? 'ok' : env.PUBLIC_ORIGIN ? 'invalid' : 'missing',
    tokenKey,
    keyState: tokenKey ? 'ok' : env.TOKEN_ENCRYPTION_KEY ? 'invalid' : 'missing',
    database: Boolean(env.DB),
    version: googleApiVersion(env.GOOGLE_API_VERSION),
    deploymentClient: !id && !secret ? 'none' : validClientId(id) && validClientSecret(secret) ? 'ok' : 'invalid',
    developerToken,
    developerTokenState: !env.GOOGLE_DEVELOPER_TOKEN ? 'none' : developerToken ? 'ok' : 'invalid',
  };
}

export const CLIENT_SECRET_CONTEXT = 'openads:instance:google-oauth-client-secret:v1';

/**
 * The instance's Google OAuth client: deployment env vars when set (they take
 * precedence), otherwise the client an admin entered in the setup wizard
 * (secret decrypted with TOKEN_ENCRYPTION_KEY). Null when none is usable.
 */
export async function googleClient(env: AppConfig, status: InstanceStatus): Promise<GoogleClient | null> {
  if (status.deploymentClient === 'ok') {
    return { clientId: env.GOOGLE_OAUTH_CLIENT_ID!, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!, source: 'deployment' };
  }
  if (status.deploymentClient === 'invalid' || !env.DB || !status.tokenKey) return null;
  const stored = await getGoogleSetup(env.DB);
  if (!stored?.client) return null;
  try {
    const clientSecret = await open(status.tokenKey, {
      ciphertext: stored.client.secretCiphertext, keyId: stored.client.secretKeyId,
    }, CLIENT_SECRET_CONTEXT);
    return { clientId: stored.client.clientId, clientSecret, source: 'instance' };
  } catch {
    return null;
  }
}

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientSource: ClientSource;
  readonly version: string;
  /** Sent only when configured (developer tokens were sunset by Google on 2026-09-09). */
  readonly developerToken: string | null;
  readonly redirectUri: string;
  readonly origin: string;
  readonly tokenKey: TokenKey;
}

/** Everything the Google Ads connection needs, or null when any part is missing or malformed. */
export async function googleConfig(env: AppConfig): Promise<GoogleConfig | null> {
  const status = await instanceStatus(env);
  if (!status.origin || !status.tokenKey || !status.database || !status.version
    || status.developerTokenState === 'invalid') return null;
  const client = await googleClient(env, status);
  if (!client) return null;
  return {
    clientId: client.clientId, clientSecret: client.clientSecret, clientSource: client.source,
    version: status.version, developerToken: status.developerToken, origin: status.origin,
    redirectUri: `${status.origin}${OAUTH_CALLBACK_PATH}`, tokenKey: status.tokenKey,
  };
}

/** OPENADS_ADMIN_EMAILS: exact addresses; null when malformed (fail closed). */
export const adminEmails = (env: AppConfig) => parseExactAddresses(env.OPENADS_ADMIN_EMAILS);
