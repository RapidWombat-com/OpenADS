import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';

export type AccessConfig = Readonly<Partial<Record<
  'ACCESS_TEAM_HOSTNAME' | 'ACCESS_AUDIENCE' | 'ACCESS_ALLOWED_EMAILS', string>>>;

type AccessFailureReason =
  | 'no_assertion' | 'assertion_too_large' | 'wrong_audience' | 'wrong_issuer'
  | 'missing_aud' | 'missing_iss' | 'missing_exp' | 'missing_iat' | 'missing_sub' | 'missing_email'
  | 'key_fetch_failure' | 'bad_signature' | 'other_rejection';

function logAccessFailure(reason: AccessFailureReason): void {
  console.warn('OPENADS_ACCESS_DIAG', reason);
}

function verificationFailureReason(error: unknown): AccessFailureReason {
  if (error instanceof errors.JWKSTimeout) return 'key_fetch_failure';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'bad_signature';
  if (error instanceof errors.JWTClaimValidationFailed) {
    // Never emit a library-provided claim name or error detail directly.
    if (error.reason === 'missing') {
      switch (error.claim) {
        case 'aud': return 'missing_aud';
        case 'iss': return 'missing_iss';
        case 'exp': return 'missing_exp';
        case 'iat': return 'missing_iat';
        case 'sub': return 'missing_sub';
        case 'email': return 'missing_email';
      }
    }
    if (error.reason === 'check_failed') {
      if (error.claim === 'aud') return 'wrong_audience';
      if (error.claim === 'iss') return 'wrong_issuer';
    }
  }
  return 'other_rejection';
}

export interface Allowlist { readonly addresses: ReadonlySet<string>; readonly domains: ReadonlySet<string> }

/** The verified Access identity of the current request. `email` is ASCII-lowercased. */
export interface AccessIdentity { readonly email: string; readonly subject: string }

// ASCII-only case folding: no Unicode case mapping or IDN normalization.
export const asciiLower = (value: string) => value.replace(/[A-Z]+/g, letters => letters.toLowerCase());
// Non-empty local part / dot-separated domain labels, no whitespace, controls, commas or extra '@'.
const LOCAL = String.raw`[^\s\x00-\x1f\x7f,@]+`;
const DOMAIN = String.raw`[^\s\x00-\x1f\x7f,@.]+(?:\.[^\s\x00-\x1f\x7f,@.]+)+`;
const ADDRESS_ENTRY = new RegExp(`^${LOCAL}@${DOMAIN}$`);
const DOMAIN_ENTRY = new RegExp(`^@${DOMAIN}$`);
const LOCAL_PART = new RegExp(`^${LOCAL}$`);

/**
 * ACCESS_ALLOWED_EMAILS: comma-separated entries, each an exact address
 * (`user@example.com`) or a whole domain (`@example.com`). Returns null when
 * any entry is malformed, so a typo fails closed instead of widening access.
 */
export function parseAllowlist(value: string | undefined): Allowlist | null {
  if (!value) return null;
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const raw of value.split(',')) {
    const entry = asciiLower(raw.trim());
    if (DOMAIN_ENTRY.test(entry)) domains.add(entry.slice(1));
    else if (ADDRESS_ENTRY.test(entry)) addresses.add(entry);
    else return null;
  }
  return { addresses, domains };
}

/**
 * Comma-separated exact addresses only (the allowlist's exact-entry rules; no
 * domain entries). Empty or unset gives an empty set; any malformed entry,
 * including a domain entry, returns null so the caller fails closed.
 */
export function parseExactAddresses(value: string | undefined): ReadonlySet<string> | null {
  const addresses = new Set<string>();
  if (value === undefined || value === '') return addresses;
  for (const raw of value.split(',')) {
    const entry = asciiLower(raw.trim());
    if (!ADDRESS_ENTRY.test(entry)) return null;
    addresses.add(entry);
  }
  return addresses;
}

/**
 * Compares ASCII-lowercased values. A domain entry matches only an address with
 * exactly one '@' whose domain part is identical: no suffix or subdomain matches.
 */
export function isAllowedEmail(email: string, allowlist: Allowlist): boolean {
  const normalized = asciiLower(email);
  const at = normalized.indexOf('@');
  if (at < 1 || at !== normalized.lastIndexOf('@') || !LOCAL_PART.test(normalized.slice(0, at))) return false;
  return allowlist.addresses.has(normalized) || allowlist.domains.has(normalized.slice(at + 1));
}

function response(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** ACCESS_TEAM_HOSTNAME: the bare Zero Trust team hostname, e.g. `your-team.cloudflareaccess.com`. */
export function validTeamHostname(value: string | undefined): boolean {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(value);
}

/** ACCESS_AUDIENCE: the Access application's audience (AUD) tag. */
export function validAudience(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\s|,/.test(value);
}

/** Denials and sanitized failures render no document, so they allow nothing. */
export const LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

/**
 * Authenticated application policy: same-origin resources only. Inline scripts and
 * style elements emitted by TanStack Start/React/Base UI must carry the per-request
 * nonce; there is no 'unsafe-inline', 'unsafe-eval', 'strict-dynamic' or data: source.
 */
export function applicationCsp(nonce: string): string {
  if (!/^[A-Za-z0-9+/]{22,}={0,2}$/.test(nonce)) throw new Error('Invalid nonce');
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** 128+ bits from the platform CSPRNG, fresh for every authenticated request. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
}

function secure(response: Response, nonce?: string): Response {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'private, no-store');
  result.headers.set('Vary', 'Accept, Cf-Access-Jwt-Assertion');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('Content-Security-Policy', nonce ? applicationCsp(nonce) : LOCKED_CSP);
  return result;
}

// No cookies, asserted email headers, unsigned JWTs, or development exceptions.
export async function protect(
  request: Request,
  config: AccessConfig,
  next: (nonce: string, identity: AccessIdentity) => Promise<Response>,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const host = config.ACCESS_TEAM_HOSTNAME;
  const audience = config.ACCESS_AUDIENCE;
  const allowlist = parseAllowlist(config.ACCESS_ALLOWED_EMAILS);
  if (!validTeamHostname(host) || !validAudience(audience) || !allowlist) {
    logAccessFailure('other_rejection');
    return secure(response('Access is not configured.', 503));
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > 16384) {
    logAccessFailure(!assertion ? 'no_assertion' : 'assertion_too_large');
    return secure(response('Unauthorized.', 401));
  }
  let keyFetchFailed = false;
  let identity: AccessIdentity;
  try {
    const issuer = `https://${host}`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5000,
      [customFetch]: async (url, options) => {
        try {
          const result = await fetcher(url, { ...options, redirect: 'manual' });
          if (result.status !== 200) keyFetchFailed = true;
          return result;
        } catch (error) {
          keyFetchFailed = true;
          throw error;
        }
      },
    });
    const { payload } = await jwtVerify(assertion, jwks, {
      algorithms: ['RS256'], issuer, audience,
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
      clockTolerance: 0,
    });
    if (typeof payload.email !== 'string' || typeof payload.sub !== 'string' || !payload.sub
      || typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000)
      || typeof payload.exp !== 'number' || payload.exp <= payload.iat) {
      logAccessFailure('other_rejection');
      return secure(response('Unauthorized.', 401));
    }
    if (!isAllowedEmail(payload.email, allowlist)) {
      logAccessFailure('other_rejection');
      return secure(response('Forbidden.', 403));
    }
    identity = Object.freeze({ email: asciiLower(payload.email), subject: payload.sub });
  } catch (error) {
    logAccessFailure(keyFetchFailed ? 'key_fetch_failure' : verificationFailureReason(error));
    return secure(response('Unauthorized.', 401));
  }
  try {
    const nonce = createNonce();
    return secure(await next(nonce, identity), nonce);
  } catch {
    return secure(response('Request unavailable.', 503));
  }
}
