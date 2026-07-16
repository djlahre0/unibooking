import { describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import { hmacSha256Hex, hmacSha256BytesBase64, base64ToBytes, verifyRs256Jwt } from '../src/crypto';

// Each helper is cross-checked against Node's crypto to prove the Web Crypto
// implementation is byte-for-byte correct.

describe('hmacSha256Hex', () => {
  it('matches node HMAC hex (Calendly-style signature)', async () => {
    const key = 'whsec_abc';
    const msg = '1700000000.{"event":"invitee.created"}';
    const expected = createHmac('sha256', key).update(msg).digest('hex');
    expect(await hmacSha256Hex(key, msg)).toBe(expected);
  });
});

describe('base64ToBytes + hmacSha256BytesBase64', () => {
  it('signs with a base64-decoded key like Boulevard', async () => {
    const secretB64 = Buffer.from('super-secret-key').toString('base64');
    const msg = 'blvd-admin-v1' + 'business-1' + '1700000000';
    const keyBytes = base64ToBytes(secretB64);
    const expected = createHmac('sha256', Buffer.from(secretB64, 'base64')).update(msg).digest('base64');
    expect(await hmacSha256BytesBase64(keyBytes, msg)).toBe(expected);
  });

  it('decodes base64 to the original bytes', () => {
    const bytes = base64ToBytes(Buffer.from([1, 2, 3, 250]).toString('base64'));
    expect([...bytes]).toEqual([1, 2, 3, 250]);
  });
});

describe('verifyRs256Jwt (Wix-style signed JWT)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  function jwt(payload: object): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}`;
    const sig = createSign('RSA-SHA256').update(input).sign(privPem).toString('base64url');
    return `${input}.${sig}`;
  }

  it('returns the decoded payload for a valid token', async () => {
    const token = jwt({ data: 'x', instanceId: 'abc' });
    expect(await verifyRs256Jwt(token, pubPem)).toMatchObject({ data: 'x', instanceId: 'abc' });
  });

  it('returns null when the payload is tampered', async () => {
    const token = jwt({ amount: 1 });
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ amount: 999 })).toString('base64url')}.${s}`;
    expect(await verifyRs256Jwt(forged, pubPem)).toBeNull();
  });

  it('returns null for a malformed token', async () => {
    expect(await verifyRs256Jwt('not-a-jwt', pubPem)).toBeNull();
    expect(await verifyRs256Jwt('a.b', pubPem)).toBeNull();
  });
});
