import { describe, expect, it, vi } from 'vitest';
import { withAutoRefresh, type OAuthClient, type OAuthTokens } from '../src/oauth';
import { googleOAuth } from '../src/oauth/google';
import { squareOAuth } from '../src/oauth/square';
import { acuityOAuth } from '../src/oauth/acuity';
import { calendlyOAuth } from '../src/oauth/calendly';
import { outlookOAuth } from '../src/oauth/microsoft';
import { setmoreOAuth } from '../src/oauth/setmore';
import { wixOAuth } from '../src/oauth/wix';

const CONFIG = {
  clientId: 'cid',
  clientSecret: 'secret-do-not-leak',
  redirectUri: 'https://app.example.com/callback',
};

/** A fetch stub that records the single request it received. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('oauth: authorizationUrl', () => {
  it('google always requests offline access and forces consent', async () => {
    // Without both of these Google issues no refresh token at all, and the
    // integration silently becomes un-renewable.
    const { url } = await googleOAuth(CONFIG).authorizationUrl();
    const q = new URL(url).searchParams;
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('cid');
    expect(q.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(q.get('scope')).toContain('https://www.googleapis.com/auth/calendar');
  });

  it('generates a random state per call, and honours a supplied one', async () => {
    const oauth = googleOAuth(CONFIG);
    const a = await oauth.authorizationUrl();
    const b = await oauth.authorizationUrl();
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThanOrEqual(16);

    const fixed = await oauth.authorizationUrl({ state: 'my-csrf-token' });
    expect(fixed.state).toBe('my-csrf-token');
    expect(new URL(fixed.url).searchParams.get('state')).toBe('my-csrf-token');
  });

  it('derives an S256 PKCE challenge and returns the verifier', async () => {
    const { url, codeVerifier } = await calendlyOAuth(CONFIG).authorizationUrl({ pkce: true });
    const q = new URL(url).searchParams;
    expect(codeVerifier).toBeTruthy();
    // RFC 7636 requires a 43-128 char verifier.
    expect(codeVerifier!.length).toBeGreaterThanOrEqual(43);
    expect(q.get('code_challenge_method')).toBe('S256');

    // The challenge must be base64url(SHA-256(verifier)) -- verified against
    // Web Crypto directly rather than trusting our own helper.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier!));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(q.get('code_challenge')).toBe(expected);
  });

  it('omits PKCE parameters when not requested', async () => {
    const { url, codeVerifier } = await googleOAuth(CONFIG).authorizationUrl();
    expect(codeVerifier).toBeUndefined();
    expect(new URL(url).searchParams.get('code_challenge')).toBeNull();
  });

  it('outlook forces offline_access even when the caller overrides scopes', async () => {
    const { url } = await outlookOAuth(CONFIG).authorizationUrl({
      scopes: ['Calendars.Read'],
    });
    expect(new URL(url).searchParams.get('scope')).toBe('offline_access Calendars.Read');
  });
});

describe('oauth: token exchange', () => {
  it('derives expiresAt from expires_in seconds', async () => {
    const { fn, calls } = stubFetch(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      scope: 'a b',
    });
    const oauth = googleOAuth({ ...CONFIG, fetch: fn, now: () => 1_000_000 } as any);
    const t = await oauth.exchangeCode('the-code');

    expect(t.accessToken).toBe('at');
    expect(t.refreshToken).toBe('rt');
    expect(t.expiresAt).toBe(new Date(1_000_000 + 3600_000).toISOString());
    expect(t.scope).toBe('a b');

    const body = String(calls[0]!.init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');
  });

  it('square reads expires_at as an RFC3339 string, not expires_in', async () => {
    // Square deviates here; a standard parser would read no expiry at all and
    // withAutoRefresh could then never refresh proactively.
    const { fn } = stubFetch(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: '2026-08-28T04:30:00Z',
      merchant_id: 'M-12345',
    });
    const t = await squareOAuth({ ...CONFIG, fetch: fn }).exchangeCode('code');
    expect(t.expiresAt).toBe('2026-08-28T04:30:00.000Z');
    expect((t.raw as any).merchant_id).toBe('M-12345');
  });

  it('acuity posts form-encoded, not JSON', async () => {
    const { fn, calls } = stubFetch(200, { access_token: 'at' });
    await acuityOAuth({ ...CONFIG, fetch: fn }).exchangeCode('code');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(String(calls[0]!.init.body)).toContain('grant_type=authorization_code');
  });

  it('sends the PKCE verifier as code_verifier', async () => {
    const { fn, calls } = stubFetch(200, { access_token: 'at' });
    await calendlyOAuth({ ...CONFIG, fetch: fn }).exchangeCode('code', {
      codeVerifier: 'the-verifier',
    });
    expect(String(calls[0]!.init.body)).toContain('the-verifier');
  });

  it('maps a rejected refresh token to AUTH and never echoes the secret', async () => {
    const { fn } = stubFetch(401, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });
    const err = await googleOAuth({ ...CONFIG, fetch: fn })
      .refresh('stale')
      .catch((e) => e);

    expect(err.code).toBe('AUTH');
    expect(err.providerCode).toBe('invalid_grant');
    expect(err.message).toContain('expired or revoked');
    // The request body carries the client secret; it must never reach the error.
    expect(err.message).not.toContain('secret-do-not-leak');
  });

  it('throws UPSTREAM when a 200 carries no access_token', async () => {
    const { fn } = stubFetch(200, { hello: 'world' });
    await expect(googleOAuth({ ...CONFIG, fetch: fn }).exchangeCode('c')).rejects.toMatchObject({
      code: 'UPSTREAM',
    });
  });
});

describe('oauth: partial providers', () => {
  it('setmore has no authorize step and says so', async () => {
    const oauth = setmoreOAuth();
    await expect(oauth.authorizationUrl()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(oauth.exchangeCode('x')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(oauth.authorizationUrl()).rejects.toThrow(/refresh token/i);
  });

  it('setmore refresh unwraps the envelope and echoes the refresh token back', async () => {
    const { fn, calls } = stubFetch(200, {
      response: true,
      data: { token: { access_token: 'at', expires_in: 7200 } },
    });
    const t = await setmoreOAuth({ fetch: fn }).refresh('r1/abc');

    expect(calls[0]!.url).toContain('refreshToken=r1%2Fabc');
    expect(t.accessToken).toBe('at');
    // Setmore does not return the refresh token; without echoing it,
    // withAutoRefresh would lose it after a single cycle.
    expect(t.refreshToken).toBe('r1/abc');
    expect(t.expiresAt).toBeTruthy();
  });

  it('setmore treats response:false on a 200 as an auth failure', async () => {
    // The envelope can report failure alongside a 2xx, so status alone lies.
    const { fn } = stubFetch(200, { response: false, msg: 'invalid refresh token' });
    await expect(setmoreOAuth({ fetch: fn }).refresh('bad')).rejects.toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('invalid refresh token'),
    });
  });

  it('wix has no authorize URL and exchanges an instanceId', async () => {
    const oauth = wixOAuth({ clientId: 'a', clientSecret: 'b' });
    await expect(oauth.authorizationUrl()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(oauth.authorizationUrl()).rejects.toThrow(/instanceId/i);

    const { fn, calls } = stubFetch(200, { access_token: 'at', refresh_token: 'rt' });
    await wixOAuth({ clientId: 'a', clientSecret: 'b', fetch: fn }).exchangeCode('INSTANCE-1');
    expect(JSON.parse(String(calls[0]!.init.body)).instance_id).toBe('INSTANCE-1');
  });
});

describe('withAutoRefresh', () => {
  const FIXED = Date.parse('2026-08-08T12:00:00Z');

  function oauthStub(next: Partial<OAuthTokens>): { oauth: OAuthClient; refresh: any } {
    const refresh = vi.fn(async (): Promise<OAuthTokens> => ({
      accessToken: 'new-at',
      raw: {},
      ...next,
    }));
    return { oauth: { provider: 'google', refresh } as unknown as OAuthClient, refresh };
  }

  it('does not refresh a token comfortably inside its lifetime', async () => {
    const { oauth, refresh } = oauthStub({});
    const onRefresh = vi.fn();
    const creds = withAutoRefresh({
      oauth,
      tokens: {
        accessToken: 'old',
        refreshToken: 'rt',
        expiresAt: new Date(FIXED + 3600_000).toISOString(),
        raw: {},
      },
      onRefresh,
      toCreds: (t) => ({ accessToken: t.accessToken }),
      now: () => FIXED,
    });

    expect(await (creds as any)()).toEqual({ accessToken: 'old' });
    expect(refresh).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('refreshes within the skew window and persists before returning', async () => {
    const order: string[] = [];
    const { oauth, refresh } = oauthStub({ refreshToken: 'rt2' });
    const creds = withAutoRefresh({
      oauth,
      tokens: {
        accessToken: 'old',
        refreshToken: 'rt',
        // 30s left, default skew is 60s.
        expiresAt: new Date(FIXED + 30_000).toISOString(),
        raw: {},
      },
      onRefresh: async (t) => {
        order.push(`persist:${t.accessToken}`);
      },
      toCreds: (t) => {
        order.push(`creds:${t.accessToken}`);
        return { accessToken: t.accessToken };
      },
      now: () => FIXED,
    });

    expect(await (creds as any)()).toEqual({ accessToken: 'new-at' });
    expect(refresh).toHaveBeenCalledWith('rt');
    // Persist must happen BEFORE the credentials are handed out.
    expect(order).toEqual(['persist:new-at', 'creds:new-at']);
  });

  it('never proactively refreshes when the provider gave no expiry', async () => {
    const { oauth, refresh } = oauthStub({});
    const creds = withAutoRefresh({
      oauth,
      tokens: { accessToken: 'old', refreshToken: 'rt', raw: {} },
      onRefresh: vi.fn(),
      toCreds: (t) => ({ accessToken: t.accessToken }),
      now: () => FIXED,
    });
    expect(await (creds as any)()).toEqual({ accessToken: 'old' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('retains the previous refresh token when the response omits one', async () => {
    // Google returns a refresh token only on first consent. Dropping it here
    // would leave the consumer holding tokens they can never renew again.
    const { oauth } = oauthStub({});
    let saved: OAuthTokens | undefined;
    const creds = withAutoRefresh({
      oauth,
      tokens: {
        accessToken: 'old',
        refreshToken: 'original-rt',
        expiresAt: new Date(FIXED).toISOString(),
        raw: {},
      },
      onRefresh: (t) => {
        saved = t;
      },
      toCreds: (t) => ({ accessToken: t.accessToken }),
      now: () => FIXED,
    });

    await (creds as any)();
    expect(saved?.refreshToken).toBe('original-rt');
  });

  it('propagates a failed persist rather than proceeding', async () => {
    // If the database write failed, continuing as though the token were saved
    // is how a rotated refresh token gets lost permanently.
    const { oauth } = oauthStub({ refreshToken: 'rotated' });
    const creds = withAutoRefresh({
      oauth,
      tokens: {
        accessToken: 'old',
        refreshToken: 'rt',
        expiresAt: new Date(FIXED).toISOString(),
        raw: {},
      },
      onRefresh: async () => {
        throw new Error('db down');
      },
      toCreds: (t) => ({ accessToken: t.accessToken }),
      now: () => FIXED,
    });

    await expect((creds as any)()).rejects.toThrow('db down');
  });

  it('refreshes only once across repeated resolutions', async () => {
    const { oauth, refresh } = oauthStub({
      refreshToken: 'rt2',
      expiresAt: new Date(FIXED + 3600_000).toISOString(),
    });
    const creds = withAutoRefresh({
      oauth,
      tokens: {
        accessToken: 'old',
        refreshToken: 'rt',
        expiresAt: new Date(FIXED).toISOString(),
        raw: {},
      },
      onRefresh: vi.fn(),
      toCreds: (t) => ({ accessToken: t.accessToken }),
      now: () => FIXED,
    });

    await (creds as any)();
    await (creds as any)();
    await (creds as any)();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
