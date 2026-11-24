// Shared server helpers for the authenticated JSON API: fixed-message responses,
// same-origin enforcement for state-changing requests, and workspace resolution.
import { asciiLower, type AccessIdentity } from './access.ts';
import { adminEmails, publicOrigin, type AppConfig } from './config.ts';
import type { Fetcher } from './providers/types.ts';
import { resolveDefaultMembership, type Membership } from './store.ts';

/** Everything a handler needs; built per request from Start's request context. */
export interface AppContext {
  readonly env: AppConfig;
  readonly identity: AccessIdentity;
  readonly fetcher: Fetcher;
  readonly now: () => number;
}

export function appContext(context: unknown, fetcher: Fetcher = fetch): AppContext {
  const value = context as { cloudflare?: { env?: AppConfig }; identity?: AccessIdentity } | undefined;
  const env = value?.cloudflare?.env;
  const identity = value?.identity;
  // The outer Access gate always provides both; anything else is a wiring bug.
  if (!env || !identity || typeof identity.email !== 'string') throw new Error('Missing request context');
  return { env, identity, fetcher, now: Date.now };
}

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Only application-authored messages; never provider bodies or exception text. */
export function apiError(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, status);
}

export function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow, ...NO_STORE } });
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...NO_STORE } });
}

/**
 * State-changing requests must be POSTs whose Origin is exactly PUBLIC_ORIGIN
 * (browsers always send Origin on POST). Fetch metadata, when present, must
 * also say same-origin. Returns a 403 response to send, or null to proceed.
 */
export function rejectCrossOrigin(request: Request, env: AppConfig): Response | null {
  const origin = publicOrigin(env.PUBLIC_ORIGIN);
  if (!origin) return apiError('Sources are not configured.', 503);
  const site = request.headers.get('Sec-Fetch-Site');
  if (request.method !== 'POST' || request.headers.get('Origin') !== origin
    || (site !== null && site !== 'same-origin')) {
    return apiError('Cross-origin request rejected.', 403);
  }
  return null;
}

/** Reads a small JSON request body; null when it is not JSON or too large. */
export async function readBody(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(type)) return null;
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface Session {
  readonly db: D1Database;
  /** Null before an admin has created the default workspace. */
  readonly membership: Membership | null;
}

/** Workspace membership of the Access identity, or a sanitized 503 when D1/admin config is missing. */
export async function session(ctx: AppContext): Promise<Session | Response> {
  const db = ctx.env.DB;
  const admins = adminEmails(ctx.env);
  if (!db || !admins) return apiError('Sources are not configured.', 503);
  const membership = await resolveDefaultMembership(db, ctx.identity.email, admins, ctx.now());
  return { db, membership };
}

export const ADMIN_ONLY = 'Only workspace admins can change sources.';

/** Instance admin (OPENADS_ADMIN_EMAILS) for setup wizards, or the response to send. */
export function requireInstanceAdmin(ctx: AppContext): Response | null {
  const admins = adminEmails(ctx.env);
  if (!admins) return apiError('Sources are not configured.', 503);
  if (!admins.has(asciiLower(ctx.identity.email))) return apiError('Only workspace admins can set up sources.', 403);
  return null;
}

/** Shared guard for setup-wizard writes: same origin, instance admin, D1 present. */
export function setupWriteGuard(request: Request, ctx: AppContext): Response | D1Database {
  const rejected = rejectCrossOrigin(request, ctx.env) ?? requireInstanceAdmin(ctx);
  if (rejected) return rejected;
  return ctx.env.DB ?? apiError('The database is not configured.', 503);
}

export function objectBody(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

export const iso = (value: number | null | undefined) =>
  (value === null || value === undefined ? null : new Date(value).toISOString());
