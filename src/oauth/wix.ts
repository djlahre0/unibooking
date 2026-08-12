import { UnibookingError, codeForStatus } from '../errors';
import { unsupportedOAuth, type OAuthClient, type OAuthTokens } from './core';

/**
 * Wix token exchange. **Partial** — no `authorizationUrl`.
 *
 * Wix's token endpoint is conventional, but the grant is not: it is keyed on an
 * **`instanceId` obtained when the site owner installs your app**, not on
 * redirecting a user to an authorize URL. There is no consent URL for this
 * library to build, so `authorizationUrl` throws rather than inventing one.
 *
 * The install flow delivers the instance id to your app's redirect endpoint;
 * pass it to `exchangeCode`, whose `code` argument is that instance id.
 *
 * Access tokens last four hours; refresh tokens are long-lived.
 */
export interface WixOAuthConfig {
  /** Wix app id. */
  clientId: string;
  /** Wix app secret. */
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const NO_AUTHORIZE =
  'Wix has no user-redirect authorize step: your app is installed from the Wix App Market, ' +
  'and the install delivers an instanceId to your redirect endpoint. ' +
  'Pass that instanceId to exchangeCode().';

export function wixOAuth(config: WixOAuthConfig): OAuthClient {
  const base = (config.baseUrl ?? 'https://www.wixapis.com').replace(/\/$/, '');

  async function post(body: Record<string, string>): Promise<OAuthTokens> {
    const doFetch = config.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(`${base}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new UnibookingError({
        provider: 'wix',
        code: 'NETWORK',
        message: 'token request failed',
        cause,
      });
    }
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { body: text };
    }
    if (!res.ok) {
      const detail = parsed?.message ?? parsed?.error_description ?? parsed?.error;
      throw new UnibookingError({
        provider: 'wix',
        code: codeForStatus(res.status),
        message: typeof detail === 'string' ? detail : `token endpoint returned ${res.status}`,
        httpStatus: res.status,
      });
    }
    const accessToken = parsed?.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new UnibookingError({
        provider: 'wix',
        code: 'UPSTREAM',
        message: 'token response contained no access_token',
      });
    }
    const expiresIn = Number(parsed?.expires_in);
    return {
      accessToken,
      ...(typeof parsed?.refresh_token === 'string' ? { refreshToken: parsed.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0
        ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
        : {}),
      raw: parsed,
    };
  }

  return {
    provider: 'wix',

    // `async` matters: the interface promises a Promise, so throwing
    // synchronously would escape a caller's .catch() and crash the request.
    authorizationUrl: async () => unsupportedOAuth('wix', `authorizationUrl — ${NO_AUTHORIZE}`),

    /** `code` is the **instanceId** delivered by the app install. */
    exchangeCode(code) {
      return post({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        instance_id: code,
      });
    },

    refresh(refreshToken) {
      return post({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
      });
    },
  };
}
