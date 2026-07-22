import { describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import { verifySquareSignature } from '../src/webhooks/square';
import { verifyAcuitySignature } from '../src/webhooks/acuity';
import { verifyGoogleChannelToken } from '../src/webhooks/google';
import { graphValidationToken, verifyGraphClientState } from '../src/webhooks/outlook';
import { verifyVagaroToken } from '../src/webhooks/vagaro';
import { verifyCalendlySignature } from '../src/webhooks/calendly';
import { verifyMindbodySignature } from '../src/webhooks/mindbody';
import { verifyBoulevardSignature } from '../src/webhooks/boulevard';
import { verifyWixWebhook } from '../src/webhooks/wix';
import { verifyBookeoSignature } from '../src/webhooks/bookeo';

// Cross-check our Web Crypto HMAC against Node's crypto to prove correctness.
function nodeHmacBase64(key: string, msg: string): string {
  return createHmac('sha256', key).update(msg).digest('base64');
}
function nodeHmacHex(key: string, msg: string): string {
  return createHmac('sha256', key).update(msg).digest('hex');
}

describe('square webhook', () => {
  const key = 'sig_key_123';
  const url = 'https://example.com/webhooks/square';
  const body = '{"type":"booking.updated","data":{}}';

  it('accepts a valid signature', async () => {
    const signature = nodeHmacBase64(key, url + body);
    expect(
      await verifySquareSignature({ signatureKey: key, notificationUrl: url, body, signature }),
    ).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const signature = nodeHmacBase64(key, url + body);
    expect(
      await verifySquareSignature({
        signatureKey: key,
        notificationUrl: url,
        body: body + 'x',
        signature,
      }),
    ).toBe(false);
  });
});

describe('acuity webhook', () => {
  it('accepts a valid signature', async () => {
    const apiKey = 'acuity_key';
    const body = 'action=appointment.scheduled&id=123';
    const signature = nodeHmacBase64(apiKey, body);
    expect(await verifyAcuitySignature({ apiKey, body, signature })).toBe(true);
    expect(await verifyAcuitySignature({ apiKey, body, signature: 'bogus' })).toBe(false);
  });
});

describe('google channel token', () => {
  it('compares the channel token', () => {
    expect(verifyGoogleChannelToken({ expectedToken: 'tok', channelToken: 'tok' })).toBe(true);
    expect(verifyGoogleChannelToken({ expectedToken: 'tok', channelToken: 'nope' })).toBe(false);
    expect(verifyGoogleChannelToken({ expectedToken: 'tok', channelToken: null })).toBe(false);
  });

  it('rejects when the expected token is empty (misconfigured watch)', () => {
    expect(verifyGoogleChannelToken({ expectedToken: '', channelToken: '' })).toBe(false);
    expect(verifyGoogleChannelToken({ expectedToken: '', channelToken: 'anything' })).toBe(false);
  });
});

describe('graph (outlook) webhook', () => {
  it('extracts the validation token from query forms', () => {
    expect(graphValidationToken('?validationToken=abc123')).toBe('abc123');
    expect(graphValidationToken(new URLSearchParams('validationToken=xyz'))).toBe('xyz');
    expect(graphValidationToken({ validationToken: 'q' })).toBe('q');
    expect(graphValidationToken('foo=bar')).toBeUndefined();
  });

  it('verifies clientState across all notifications', () => {
    const payload = { value: [{ clientState: 'secret' }, { clientState: 'secret' }] };
    expect(verifyGraphClientState(payload, 'secret')).toBe(true);
    expect(verifyGraphClientState(payload, 'other')).toBe(false);
    expect(verifyGraphClientState({ value: [] }, 'secret')).toBe(false);
    expect(verifyGraphClientState({ value: [{ clientState: 'secret' }, {}] }, 'secret')).toBe(
      false,
    );
  });
});

describe('vagaro webhook token', () => {
  it('accepts a matching token', () => {
    expect(verifyVagaroToken('shared-secret', 'shared-secret')).toBe(true);
  });
  it('rejects a wrong token', () => {
    expect(verifyVagaroToken('nope', 'shared-secret')).toBe(false);
  });
  it('rejects a missing header', () => {
    expect(verifyVagaroToken(null, 'shared-secret')).toBe(false);
    expect(verifyVagaroToken(undefined, 'shared-secret')).toBe(false);
  });
  it('rejects when expected is empty', () => {
    expect(verifyVagaroToken('x', '')).toBe(false);
  });
});

describe('calendly webhook', () => {
  const key = 'whsec_calendly';
  const body = '{"event":"invitee.created","payload":{}}';
  const t = '1710000000';

  it('accepts a valid t=,v1= signature', async () => {
    const v1 = nodeHmacHex(key, `${t}.${body}`);
    const header = `t=${t},v1=${v1}`;
    expect(await verifyCalendlySignature({ signingKey: key, body, signatureHeader: header })).toBe(
      true,
    );
  });

  it('rejects a tampered body', async () => {
    const v1 = nodeHmacHex(key, `${t}.${body}`);
    const header = `t=${t},v1=${v1}`;
    expect(
      await verifyCalendlySignature({ signingKey: key, body: body + 'x', signatureHeader: header }),
    ).toBe(false);
  });

  it('rejects a malformed header', async () => {
    expect(
      await verifyCalendlySignature({ signingKey: key, body, signatureHeader: 'garbage' }),
    ).toBe(false);
  });
});

describe('mindbody webhook', () => {
  const key = 'mb_sig_key';
  const body = '{"eventId":"appointmentBooking.cancelled"}';

  it('accepts a valid signature (with and without the sha256= prefix)', async () => {
    const sig = nodeHmacBase64(key, body);
    expect(await verifyMindbodySignature({ signatureKey: key, body, signature: sig })).toBe(true);
    expect(
      await verifyMindbodySignature({ signatureKey: key, body, signature: `sha256=${sig}` }),
    ).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const sig = nodeHmacBase64(key, body);
    expect(
      await verifyMindbodySignature({ signatureKey: key, body: body + 'x', signature: sig }),
    ).toBe(false);
  });
});

describe('boulevard webhook (salted HMAC)', () => {
  // Boulevard signs `salt + ":" + rawBody` with the base64-DECODED app secret,
  // and emits base64 only. The secret is base64 text at rest.
  const rawSecret = Buffer.from('blvd-app-secret-bytes');
  const secret = rawSecret.toString('base64');
  const salt = 'blvd-webhook-v1:efa1a1fd-80b2-41c8-8b13-850f36f9a303:1600717631';
  const body = '{"type":"appointment.created"}';
  const payload = `${salt}:${body}`;

  const sign = (key: Buffer, msg: string): string =>
    createHmac('sha256', key).update(msg).digest('base64');

  it('accepts a base64 signature over salt + ":" + body', async () => {
    expect(
      await verifyBoulevardSignature({
        signingSecret: secret,
        salt,
        body,
        signature: sign(rawSecret, payload),
      }),
    ).toBe(true);
  });

  it('rejects a signature computed without the colon separator', async () => {
    expect(
      await verifyBoulevardSignature({
        signingSecret: secret,
        salt,
        body,
        signature: sign(rawSecret, salt + body),
      }),
    ).toBe(false);
  });

  it('rejects a signature keyed with the undecoded base64 secret', async () => {
    expect(
      await verifyBoulevardSignature({
        signingSecret: secret,
        salt,
        body,
        signature: sign(Buffer.from(secret), payload),
      }),
    ).toBe(false);
  });

  it('rejects a tampered body', async () => {
    expect(
      await verifyBoulevardSignature({
        signingSecret: secret,
        salt,
        body: body + 'x',
        signature: sign(rawSecret, payload),
      }),
    ).toBe(false);
  });

  it('rejects when the salt is wrong', async () => {
    expect(
      await verifyBoulevardSignature({
        signingSecret: secret,
        salt: 'blvd-webhook-v1:other:1600717631',
        body,
        signature: sign(rawSecret, payload),
      }),
    ).toBe(false);
  });

  it('rejects a hex signature — Boulevard never emits hex', async () => {
    expect(
      await verifyBoulevardSignature({
        signingSecret: secret,
        salt,
        body,
        signature: createHmac('sha256', rawSecret).update(payload).digest('hex'),
      }),
    ).toBe(false);
  });
});

describe('wix webhook (signed JWT)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  function jwt(payload: object): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}`;
    const sig = createSign('RSA-SHA256').update(input).sign(privPem).toString('base64url');
    return `${input}.${sig}`;
  }

  it('returns the decoded event payload for a valid JWT', async () => {
    const token = jwt({ data: '{"entityId":"B1"}', instanceId: 'abc' });
    const payload = await verifyWixWebhook({ jwt: token, publicKey: pubPem });
    expect(payload).toMatchObject({ instanceId: 'abc' });
  });

  it('returns null for a JWT signed by a different key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const token = jwt({ data: 'x' });
    expect(await verifyWixWebhook({ jwt: token, publicKey: otherPem })).toBeNull();
  });
});

describe('bookeo webhook (HMAC-SHA256 hex)', () => {
  // Bookeo's own published worked example. Every string below is verbatim from
  // their docs, including the query string on the URL — this is the whole test.
  const secretKey = 'iWQlbsuksGUqStFPk46WVjpGO7vVQoeO';
  const timestamp = '1683025420401';
  const messageId = 'dvpwVQI0W7Pe187dc203154';
  const webhookUrl = 'https://www.mywebsite.com/webhooktest?id=1234';
  const body =
    '{"itemId":"2856MUMPA187DC203130","timestamp":"2023-05-02T04:01:00-07:00","item":{"credit":{"amount":"0",' +
    '"currency":"USD"},"acceptSmsReminders":true,"numBookings":0,"numCancelations":0,"numNoShows":0,"member":false,' +
    '"id":"2856MUMPA187DC203130","firstName":"John","lastName":"Smith","streetAddress":{"countryCode":"US"},' +
    '"creationTime":"2023-05-02T04:01:00-07:00","gender":"unknown"}}';
  const signature = 'a3cec455a9462fc524b02eeac7a26af743d512763271ab170f957aeafd6a636e';

  const input = { secretKey, timestamp, messageId, webhookUrl, body, signature };

  it("reproduces the signature from Bookeo's published test vector", async () => {
    expect(await verifyBookeoSignature(input)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    expect(await verifyBookeoSignature({ ...input, body: body + 'x' })).toBe(false);
  });

  it('rejects when the URL query string is stripped', async () => {
    // The query string is part of the signed message — no normalization.
    expect(
      await verifyBookeoSignature({
        ...input,
        webhookUrl: 'https://www.mywebsite.com/webhooktest',
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp when a tolerance is supplied', async () => {
    expect(
      await verifyBookeoSignature({
        ...input,
        toleranceMs: 120_000,
        now: () => Number(timestamp) + 300_000,
      }),
    ).toBe(false);
  });

  it('accepts a fresh timestamp within tolerance', async () => {
    expect(
      await verifyBookeoSignature({
        ...input,
        toleranceMs: 120_000,
        now: () => Number(timestamp) + 5_000,
      }),
    ).toBe(true);
  });
});
