// Web Crypto helpers: provider grants at rest, OAuth state and PKCE.
// No dependency, no logging; every failure is a generic Error.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid encoding');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** URL-safe random value with `bytes` bytes of CSPRNG entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

/** RFC 7636 S256 challenge for a verifier. */
export const pkceChallenge = (verifier: string) => sha256(verifier);

export interface TokenKey { readonly id: string; readonly key: CryptoKey }

/**
 * TOKEN_ENCRYPTION_KEY: standard base64 of exactly 32 random bytes (AES-256).
 * The key id stored next to each ciphertext is a domain-separated SHA-256
 * fingerprint of the key, so a rotated or wrong key is detected before use
 * and fails closed instead of producing garbage. Returns null when unset or invalid.
 */
export async function importTokenKey(value: string | undefined): Promise<TokenKey | null> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (raw.byteLength !== 32) return null;
  const label = encoder.encode('openads-token-key-id:v1:');
  const material = new Uint8Array(label.byteLength + raw.byteLength);
  material.set(label);
  material.set(raw, label.byteLength);
  const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  const id = `k1-${[...fingerprint.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { id, key };
}

export interface Sealed { readonly ciphertext: string; readonly keyId: string }

/** AES-256-GCM with a random 96-bit IV; `context` is authenticated (AAD), not stored. */
export async function seal(tokenKey: TokenKey, plaintext: string, context: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, tokenKey.key, encoder.encode(plaintext)));
  return { ciphertext: `v1.${base64url(iv)}.${base64url(ciphertext)}`, keyId: tokenKey.id };
}

/** Throws on a different key id, a malformed value, a wrong context or any tampering. */
export async function open(tokenKey: TokenKey, sealed: Sealed, context: string): Promise<string> {
  if (sealed.keyId !== tokenKey.id) throw new Error('Unknown key');
  const parts = sealed.ciphertext.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unknown format');
  const iv = fromBase64url(parts[1]!);
  const data = fromBase64url(parts[2]!);
  if (iv.byteLength !== 12 || data.byteLength < 17) throw new Error('Invalid ciphertext');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, tokenKey.key, data);
  return decoder.decode(plaintext);
}

/** AAD binding a refresh-token ciphertext to its row and tenant. */
export const grantContext = (workspaceId: string, connectionId: string) =>
  `openads:grant:v1:${workspaceId}:${connectionId}`;

/**
 * AAD of a grant waiting for confirmation (pending_connection): a different
 * domain than grantContext, so a pending ciphertext can never be opened as a
 * connection's grant (or the other way round).
 */
export const pendingGrantContext = (workspaceId: string, pendingId: string) =>
  `openads:pending-grant:v1:${workspaceId}:${pendingId}`;
