'use client';

import { useState } from 'react';
import { callCheckConnection, type ActionResult, type Connection } from '../lib/call';

export type Verdict = {
  tone: 'ok' | 'bad' | 'warn';
  title: string;
  detail?: string;
  /** What to try next, when the check failed. */
  hints?: string[];
};

type Status = {
  ok: boolean;
  reason?: 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND';
  message?: string;
  account?: { id?: string; name?: string; email?: string };
};

const AUTH_HINTS = (env: string, hasSandbox: boolean): string[] => [
  'Check the token was copied in full, with no spaces or line breaks.',
  'Tokens expire or get revoked; generate a fresh one if this one is old.',
  ...(hasSandbox
    ? [
        `The Environment (under Advanced) is "${env}". A sandbox token only works against sandbox, and a production token only against production.`,
      ]
    : []),
];

/**
 * Turn `checkConnection()`'s answer into one plain-language verdict.
 *
 * `checkConnection` returns `{ ok: false, reason }` for the three answers that
 * mean "these credentials don't work" and throws for everything else, so both
 * halves of an ActionResult are read here. Some adapters also surface a
 * rejected token as a thrown AUTH error; that lands in the same verdict.
 */
export function verdictOf(res: ActionResult, env: string, hasSandbox: boolean): Verdict {
  if (res.ok) {
    const status = (res.data ?? {}) as Status;
    if (status.ok) {
      const a = status.account ?? {};
      const who = [a.name, a.email].filter(Boolean).join(' · ') || a.id;
      return {
        tone: 'ok',
        title: 'Connected: the provider accepted these credentials',
        detail: who
          ? `Signed in as ${who}${a.id && who !== a.id ? ` (id ${a.id})` : ''}.`
          : undefined,
      };
    }
    return rejected(status.reason, status.message, env, hasSandbox);
  }

  const err = res.error ?? { message: 'Unknown error' };
  switch (err.code) {
    case 'AUTH':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
      return rejected(err.code, err.message, env, hasSandbox);
    case 'INVALID_INPUT':
      return {
        tone: 'bad',
        title: 'The credentials are incomplete or malformed',
        detail: err.message,
        hints: ['Fill in every field in steps 1 and 2, and check ids are in the format shown.'],
      };
    case 'RATE_LIMIT':
      return {
        tone: 'warn',
        title: 'The provider is rate-limiting requests',
        detail: err.message,
        hints: ['Wait a minute and test again. This says nothing about the credentials.'],
      };
    case 'NETWORK':
    case 'TIMEOUT':
    case 'UPSTREAM':
      return {
        tone: 'warn',
        title: "Couldn't get an answer from the provider",
        detail: err.message,
        hints: [
          'This is a network or provider-side problem, not a verdict on the credentials.',
          'Check the Environment / base URL under Advanced, then try again.',
        ],
      };
    default:
      return {
        tone: 'bad',
        title: 'The connection test failed',
        detail: err.message,
      };
  }
}

function rejected(
  reason: string | undefined,
  message: string | undefined,
  env: string,
  hasSandbox: boolean,
): Verdict {
  switch (reason) {
    case 'FORBIDDEN':
      return {
        tone: 'bad',
        title: 'The token is valid but not allowed to do this',
        detail: message,
        hints: [
          'The token is missing a permission (scope). Re-create it with read and write access to bookings/appointments.',
          'Some providers also need the app to be approved for this account or location.',
        ],
      };
    case 'NOT_FOUND':
      return {
        tone: 'bad',
        title: "The token works, but an id doesn't match",
        detail: message,
        hints: [
          'Check the ids in step 2 (location, business, site or calendar) belong to the account this token is for.',
        ],
      };
    default:
      return {
        tone: 'bad',
        title: 'The provider rejected these credentials',
        detail: message,
        hints: AUTH_HINTS(env, hasSandbox),
      };
  }
}

export type ConnectionCheckProps = {
  providerId: string;
  conn: Connection;
  /** Labels of required fields that are still empty. Non-empty disables the
   *  test: an obviously incomplete connection is reported without a call. */
  missing: string[];
  /** The Environment control's current value, for the sandbox/prod hint. */
  env: string;
  /** Whether this provider has a separate sandbox host at all. */
  hasSandbox: boolean;
};

/**
 * "Test connection": one real round trip to the provider through
 * `checkConnection()`, which every adapter implements as its cheapest
 * authenticated read. Unlike the capabilities table, this proves the token,
 * the ids and the environment all line up.
 */
export default function ConnectionCheck({
  providerId,
  conn,
  missing,
  env,
  hasSandbox,
}: ConnectionCheckProps) {
  // Keyed on the exact provider + connection tested, so a verdict never
  // outlives an edit to the token, ids or environment it was about.
  const key = `${providerId}|${JSON.stringify(conn)}`;
  const [state, setState] = useState<{ key: string; verdict: Verdict; ms: number } | null>(null);
  const [running, setRunning] = useState(false);

  async function test() {
    setRunning(true);
    const t0 = performance.now();
    try {
      const res = await callCheckConnection(providerId, conn);
      setState({
        key,
        verdict: verdictOf(res, env, hasSandbox),
        ms: Math.round(performance.now() - t0),
      });
    } finally {
      setRunning(false);
    }
  }

  const current = state?.key === key ? state : null;

  return (
    <div className="conn-check">
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void test()}
        disabled={running || missing.length > 0}
      >
        {running ? 'Testing…' : 'Test connection'}
      </button>
      {missing.length > 0 ? (
        <p className="cal-muted conn-check-missing">Fill in {missing.join(', ')} first.</p>
      ) : null}
      {current ? (
        <div className={`conn-verdict conn-verdict-${current.verdict.tone}`} role="status">
          <div className="conn-verdict-title">
            <span aria-hidden="true">
              {current.verdict.tone === 'ok' ? '✓' : current.verdict.tone === 'warn' ? '!' : '✗'}
            </span>{' '}
            {current.verdict.title}
            <span className="conn-verdict-ms">{current.ms} ms</span>
          </div>
          {current.verdict.detail ? (
            <p className="conn-verdict-detail">{current.verdict.detail}</p>
          ) : null}
          {current.verdict.hints?.length ? (
            <ul className="conn-verdict-hints">
              {current.verdict.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
