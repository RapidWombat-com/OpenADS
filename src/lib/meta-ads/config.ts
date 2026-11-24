// Instance configuration of the Meta Ads connection (self-hosting): the
// operator's own Meta app (App ID + App Secret), the Graph API version and the
// conversion action type. Deployment env vars take precedence over values an
// instance admin entered in the setup wizard; nothing is specific to one deployment.
import { publicOrigin, type AppConfig } from '../config.ts';
import { importTokenKey, open, type TokenKey } from '../crypto.ts';
import { getMetaSetup } from '../store.ts';

/**
 * Graph/Marketing API version used when META_API_VERSION is not set. Pinned per
 * OpenADS release (v27.0: released 2026-11-04); an operator may override it
 * with a newer supported version.
 */
export const META_GRAPH_API_VERSION = 'v27.0';
export const META_OAUTH_CALLBACK_PATH = '/api/oauth/meta/callback';
/** Read-only: lists ad accounts (/me/adaccounts) and reads Insights. No other permission is requested. */
export const META_SCOPE = 'ads_read';
export const DEFAULT_CONVERSION_ACTION_TYPE = 'purchase';
export const APP_SECRET_CONTEXT = 'openads:instance:meta-app-secret:v1';

/** META_API_VERSION when set (`v` plus major.minor), else the pinned default; null when malformed. */
export function metaApiVersion(value: string | undefined): string | null {
  if (value === undefined || value === '') return META_GRAPH_API_VERSION;
  return /^v\d{1,3}\.\d{1,2}$/.test(value) ? value : null;
}

/** Meta App IDs are numeric (typically 15–16 digits). */
export function validMetaAppId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
}

/** Meta App Secrets are 32 hexadecimal characters (App Dashboard → App settings → Basic). */
export function validMetaAppSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value);
}

/**
 * An exact Insights `action_type`: lowercase identifiers joined by dots, such as
 * `purchase`, `omni_purchase`, `offsite_conversion.fb_pixel_purchase` or
 * `offsite_conversion.custom.123456789`.
 */
export function validActionType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(value);
}

export type MetaAppSource = 'deployment' | 'instance';

export interface MetaStatus {
  readonly origin: string | null;
  readonly originState: 'ok' | 'missing' | 'invalid';
  readonly tokenKey: TokenKey | null;
  readonly keyState: 'ok' | 'missing' | 'invalid';
  readonly database: boolean;
  readonly version: string | null;
  /** META_APP_ID/META_APP_SECRET in the deployment: none, both valid, or incomplete/malformed. */
  readonly deploymentApp: 'none' | 'ok' | 'invalid';
  /** META_CONVERSION_ACTION_TYPE in the deployment. */
  readonly deploymentActionType: 'none' | 'ok' | 'invalid';
}

/** Deploy-time prerequisites of the Meta Ads connection, without touching D1. */
export async function metaStatus(env: AppConfig): Promise<MetaStatus> {
  const origin = publicOrigin(env.PUBLIC_ORIGIN);
  const tokenKey = env.TOKEN_ENCRYPTION_KEY ? await importTokenKey(env.TOKEN_ENCRYPTION_KEY) : null;
  const id = env.META_APP_ID ?? '';
  const secret = env.META_APP_SECRET ?? '';
  const actionType = env.META_CONVERSION_ACTION_TYPE ?? '';
  return {
    origin,
    originState: origin ? 'ok' : env.PUBLIC_ORIGIN ? 'invalid' : 'missing',
    tokenKey,
    keyState: tokenKey ? 'ok' : env.TOKEN_ENCRYPTION_KEY ? 'invalid' : 'missing',
    database: Boolean(env.DB),
    version: metaApiVersion(env.META_API_VERSION),
    deploymentApp: !id && !secret ? 'none' : validMetaAppId(id) && validMetaAppSecret(secret) ? 'ok' : 'invalid',
    deploymentActionType: !actionType ? 'none' : validActionType(actionType) ? 'ok' : 'invalid',
  };
}

export interface MetaApp {
  readonly appId: string;
  readonly appSecret: string;
  readonly source: MetaAppSource;
}

/**
 * The instance's Meta app: deployment env vars when set (they take precedence),
 * otherwise the app an admin entered in the setup wizard (secret decrypted with
 * TOKEN_ENCRYPTION_KEY). Null when none is usable.
 */
export async function metaApp(env: AppConfig, status: MetaStatus): Promise<MetaApp | null> {
  if (status.deploymentApp === 'ok') {
    return { appId: env.META_APP_ID!, appSecret: env.META_APP_SECRET!, source: 'deployment' };
  }
  if (status.deploymentApp === 'invalid' || !env.DB || !status.tokenKey) return null;
  const stored = await getMetaSetup(env.DB);
  if (!stored?.appId || !stored.secret) return null;
  try {
    const appSecret = await open(status.tokenKey, { ciphertext: stored.secret.ciphertext, keyId: stored.secret.keyId },
      APP_SECRET_CONTEXT);
    return validMetaAppSecret(appSecret) ? { appId: stored.appId, appSecret, source: 'instance' } : null;
  } catch {
    return null;
  }
}

export interface MetaConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly appSource: MetaAppSource;
  readonly version: string;
  readonly redirectUri: string;
  readonly origin: string;
  readonly tokenKey: TokenKey;
}

/** Everything the Meta Ads connection needs, or null when any part is missing or malformed. */
export async function metaConfig(env: AppConfig): Promise<MetaConfig | null> {
  const status = await metaStatus(env);
  if (!status.origin || !status.tokenKey || !status.database || !status.version
    || status.deploymentActionType === 'invalid') return null;
  const app = await metaApp(env, status);
  if (!app) return null;
  return {
    appId: app.appId, appSecret: app.appSecret, appSource: app.source, version: status.version,
    origin: status.origin, redirectUri: `${status.origin}${META_OAUTH_CALLBACK_PATH}`, tokenKey: status.tokenKey,
  };
}

export interface ConversionSetting {
  readonly value: string;
  readonly source: 'deployment' | 'instance' | 'default';
}

/**
 * The exact Insights action type counted as Meta conversions: META_CONVERSION_ACTION_TYPE
 * when set, else the value saved on the Sources page, else `purchase`. Null when
 * the deployment value is malformed (reports fail closed rather than guess).
 */
export async function conversionActionType(env: AppConfig): Promise<ConversionSetting | null> {
  const configured = env.META_CONVERSION_ACTION_TYPE;
  if (configured) return validActionType(configured) ? { value: configured, source: 'deployment' } : null;
  const stored = env.DB ? (await getMetaSetup(env.DB))?.conversionActionType ?? null : null;
  return stored && validActionType(stored)
    ? { value: stored, source: 'instance' } : { value: DEFAULT_CONVERSION_ACTION_TYPE, source: 'default' };
}

/** Days before expiry when Sources and the dashboard start asking for a reconnect. */
export const EXPIRY_WARNING_MS = 7 * 86_400_000;

/**
 * Token lifecycle as shown to people: `none` (no known expiry), `ok`, `soon`
 * (within EXPIRY_WARNING_MS) or `past`.
 */
export function expiryState(tokenExpiresAt: number | null, now: number): 'none' | 'ok' | 'soon' | 'past' {
  if (tokenExpiresAt === null) return 'none';
  if (tokenExpiresAt <= now) return 'past';
  return tokenExpiresAt - now <= EXPIRY_WARNING_MS ? 'soon' : 'ok';
}
