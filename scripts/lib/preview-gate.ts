// LOCAL RUN HARNESS ONLY (scripts/preview.mjs --live). Never deployed; nothing
// in src/ imports it.
//
// `--live` talks to real Google and Meta with real grants, so the local server
// must not answer anyone but the operator who started it: it listens on
// 127.0.0.1 only, and every request needs a cookie that only the one-time
// sign-in URL printed in the terminal sets. Other local users, other processes
// and web pages (DNS rebinding, cross-site requests) get 401/421.
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session cookie name for a run on `port`. Browsers do not scope cookies by port,
 * so every port gets its own name: a run on another port never sees, replaces or
 * accepts this one.
 */
export const previewCookieName = (port: number) => `openads_preview_${port}`;
/** Any preview session cookie (this port's or another run's): never forwarded to the Worker. */
const ANY_PREVIEW_COOKIE = /^openads_preview(?:_\d+)?=/;
const OAUTH_CALLBACKS = new Set(['/api/oauth/google/callback', '/api/oauth/meta/callback']);

/** The parts of an incoming request the gate looks at (node:http's IncomingMessage fits). */
export interface GateRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type GateResult =
  /** Send this response; do not forward the request. */
  | { readonly response: Response }
  /** Forward the request with this Cookie header (the preview cookie removed; null: none). */
  | { readonly cookie: string | null };

const header = (request: GateRequest, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join('; ') : value ?? null;
};

const same = (a: string | null, b: string) => {
  if (a === null) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;
const text = (status: number, body: string) => new Response(`${body}\n`, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE },
});
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/**
 * The gate for one run. `signInUrl` is printed once; its token works once and
 * sets an HttpOnly, SameSite=Strict session cookie `openads_preview_<port>`
 * (random, per run, never printed). `check` decides every request.
 */
export function createPreviewGate(port: number, random: (bytes: number) => Buffer = randomBytes) {
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  let token: string | null = random(32).toString('base64url');
  const session = random(32).toString('base64url');
  const signInUrl = `${origin}/?preview_token=${token}`;
  const cookieName = previewCookieName(port);

  function check(request: GateRequest): GateResult {
    // Only the address it listens on: a rebound DNS name (another site's page) is refused.
    if (header(request, 'host') !== host) return { response: text(421, `Open ${origin}/ (the sign-in link printed in the terminal).`) };
    const url = new URL(request.url ?? '/', origin);
    const method = request.method ?? 'GET';
    const presented = url.searchParams.get('preview_token');
    if (presented !== null) {
      if (method !== 'GET' || token === null || !same(presented, token)) {
        return { response: text(401, 'This sign-in link is not valid or was already used. Restart the preview for a new one.') };
      }
      token = null; // One-time.
      return {
        response: new Response(null, {
          status: 303,
          headers: { Location: '/', 'Set-Cookie': `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`, ...NO_STORE },
        }),
      };
    }
    const parts = (header(request, 'cookie') ?? '').split(';').map(part => part.trim()).filter(Boolean);
    const ours = parts.filter(part => part.startsWith(`${cookieName}=`));
    if (ours.length === 1 && same(ours[0]!.slice(cookieName.length + 1), session)) {
      const rest = parts.filter(part => !ANY_PREVIEW_COOKIE.test(part));
      return { cookie: rest.length ? rest.join('; ') : null };
    }
    // Google/Meta redirect back cross-site, and browsers do not send a SameSite=Strict
    // cookie on that navigation: load the same URL again from this origin, once (the
    // second request is same-origin, so it carries the cookie or ends in 401).
    if (method === 'GET' && OAUTH_CALLBACKS.has(url.pathname) && header(request, 'sec-fetch-site') === 'cross-site') {
      const target = escape(`${url.pathname}${url.search}`);
      return {
        response: new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Continuing…</title><a href="${target}">Continue</a>\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'", ...NO_STORE },
        }),
      };
    }
    return { response: text(401, 'Sign in with the one-time link printed in the terminal where the preview runs.') };
  }

  return { origin, signInUrl, cookieName, check };
}
