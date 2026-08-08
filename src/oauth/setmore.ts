import { UnibookingError, codeForStatus } from '../errors';
import { unsupportedOAuth, type OAuthClient, type OAuthTokens } from './core';

/**
 * Setmore token exchange. **Partial** — `refresh` only.
 *
 * Setmore has no authorization-code flow at all. There is no consent screen and
 * no redirect: the salon owner generates a long-lived **refresh token** in their
 * Setmore account and pastes it into your UI. You then exchange it for a
 * short-lived access token.
 *
 * So `authorizationUrl` and `exchangeCode` throw `UNSUPPORTED` rather than
 * pretending a flow exists, and `refresh` is the whole surface.
 *
 * The exchange is a **GET with the token in the query string**, and it takes no
 * client id or secret — which is why this module needs no config. Access tokens
 * last 7200 seconds (two hours), so a long-lived process must refresh rather
 * than cache.
 */
export interface SetmoreOAuthConfig {
  /** Override the host (there is no sandbox; use a throwaway account). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const NO_FLOW =
  'Setmore has no authorization-code flow: the account owner generates a long-lived ' +
  'refresh token in their Setmore settings and pastes it in. Call refresh() with that token.';

export function setmoreOAuth(config: SetmoreOAuthConfig = {}): OAuthClient {
  const base = (config.baseUrl ?? 'https://developer.setmore.com').replace(/\/$/, '');

  return {
    provider: 'setmore',

    // `async` matters: the interface promises a Promise, so throwing
    // synchronously would escape a caller's .catch() and crash the request.
    authorizationUrl: async () => unsupportedOAuth('setmore', `authorizationUrl — ${NO_FLOW}`),

    exchangeCode: async () => unsupportedOAuth('setmore', `exchangeCode — ${NO_FLOW}`),

    async refresh(refreshToken): Promise<OAuthTokens> {
      const doFetch = config.fetch ?? globalThis.fetch;
      const url = `${base}/api/v1/o/oauth2/token?refreshToken=${encodeURIComponent(refreshToken)}`;
      let res: Response;
      try {
        res = await doFetch(url, { method: 'GET', headers: { accept: 'application/json' } });
      } catch (cause) {
        throw new UnibookingError({
          provider: 'setmore',
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

      // Setmore signals failure with `response: false`, sometimes alongside a
      // 2xx — the HTTP status alone cannot be trusted here, exactly as in the
      // adapter.
      if (!res.ok || parsed?.response === false) {
        throw new UnibookingError({
          provider: 'setmore',
          code: res.ok ? 'AUTH' : codeForStatus(res.status),
          message:
            typeof parsed?.msg === 'string' ? parsed.msg : 'Setmore rejected the refresh token',
          ...(res.ok ? {} : { httpStatus: res.status }),
        });
      }

      const token = parsed?.data?.token;
      const accessToken = token?.access_token;
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new UnibookingError({
          provider: 'setmore',
          code: 'UPSTREAM',
          message: 'token response contained no data.token.access_token',
        });
      }
      const expiresIn = Number(token?.expires_in);
      return {
        accessToken,
        // The refresh token is long-lived and unchanged by the exchange, so echo
        // it back — otherwise withAutoRefresh would lose it after one cycle.
        refreshToken,
        ...(Number.isFinite(expiresIn) && expiresIn > 0
          ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
          : {}),
        raw: parsed,
      };
    },
  };
}
