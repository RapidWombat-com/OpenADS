import assert from 'node:assert/strict';
import test from 'node:test';
import { grantContext, importTokenKey, open, pkceChallenge, randomToken, seal, sha256 } from '../src/lib/crypto.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const context = grantContext('workspace-a', 'connection-1');

test('token key: exactly 32 bytes of standard base64, otherwise not configured', async () => {
  for (const value of [undefined, '', 'short', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'),
    Buffer.alloc(32, 7).toString('base64url'), ` ${KEY}`, `${KEY}\n`, KEY.replace('=', '')]) {
    assert.equal(await importTokenKey(value), null, String(value));
  }
  const key = await importTokenKey(KEY);
  assert.ok(key);
  assert.match(key.id, /^k1-[0-9a-f]{16}$/);
  assert.equal((await importTokenKey(KEY))!.id, key.id, 'stable key id');
  assert.notEqual((await importTokenKey(OTHER_KEY))!.id, key.id);
  assert.equal(key.key.extractable, false);
});

test('AES-GCM round trip with a fresh IV; ciphertext never contains the token', async () => {
  const key = (await importTokenKey(KEY))!;
  const token = '1//fixture-refresh-token-value';
  const first = await seal(key, token, context);
  const second = await seal(key, token, context);
  assert.match(first.ciphertext, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.equal(first.keyId, key.id);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.includes('fixture-refresh'), false);
  assert.equal(await open(key, first, context), token);
  assert.equal(await open(key, second, context), token);
});

test('wrong key, wrong row context, tampering and malformed values fail closed', async () => {
  const key = (await importTokenKey(KEY))!;
  const other = (await importTokenKey(OTHER_KEY))!;
  const sealed = await seal(key, 'secret-refresh', context);
  // A rotated key is detected by id before any decryption.
  await assert.rejects(open(other, sealed, context));
  // Even with a forged matching id, AES-GCM authentication fails.
  await assert.rejects(open({ id: key.id, key: other.key }, sealed, context));
  // The ciphertext is bound to its workspace and connection.
  await assert.rejects(open(key, sealed, grantContext('workspace-b', 'connection-1')));
  await assert.rejects(open(key, sealed, grantContext('workspace-a', 'connection-2')));
  const [version, iv, data] = sealed.ciphertext.split('.');
  const flipped = `${data!.slice(0, -2)}${data!.endsWith('AA') ? 'AB' : 'AA'}`;
  for (const ciphertext of [`${version}.${iv}.${flipped}`, `v2.${iv}.${data}`, `${version}.${iv}`, 'garbage',
    `${version}.${iv}.${data}.x`, `${version}.${iv!.slice(2)}.${data}`, `${version}.${iv}.***`]) {
    await assert.rejects(open(key, { ciphertext, keyId: sealed.keyId }, context), ciphertext);
  }
});

test('PKCE S256 matches the RFC 7636 example; random tokens are URL-safe and unique', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const values = new Set(Array.from({ length: 50 }, () => randomToken(32)));
  assert.equal(values.size, 50);
  for (const value of values) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.match(randomToken(48), /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(await sha256('a'), await sha256('b'));
});
