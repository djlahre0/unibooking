import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import type { Booking, BookingClient, ProviderId } from '../src/types';
import { isInstant } from '../src/time';

const JSON_HEADERS = { 'content-type': 'application/json' };
const VALID_STATUSES = [
  'confirmed',
  'pending',
  'cancelled',
  'declined',
  'no_show',
  'completed',
  'unknown',
];

export interface ConformanceCase {
  name: string;
  method: string;
  /** Pathname prefix to intercept (query is ignored). */
  path: string;
  /** Happy-path response body (object → JSON, string → verbatim). */
  reply: unknown;
  status?: number;
  run: (client: BookingClient) => Promise<unknown>;
  check?: (result: any) => void;
}

export interface ConformanceConfig {
  provider: ProviderId;
  origin: string;
  makeClient: () => BookingClient;
  cases: ConformanceCase[];
  /** A single-request method used to exercise error-status mapping. */
  errorProbe: { method: string; path: string; run: (client: BookingClient) => Promise<unknown> };
}

function pathname(full: string): string {
  const q = full.indexOf('?');
  return q === -1 ? full : full.slice(0, q);
}

function body(reply: unknown): string {
  return typeof reply === 'string' ? reply : JSON.stringify(reply);
}

/** Canonical invariants every Booking must satisfy, regardless of provider. */
export function assertCanonicalBooking(b: Booking, provider: ProviderId): void {
  expect(b.id, 'booking.id is non-empty').toBeTruthy();
  expect(b.provider).toBe(provider);
  expect(typeof b.title).toBe('string');
  // Canonical instants must carry an explicit offset (Z or ±HH:MM), not merely
  // be parseable — an offset-less string is an ambiguous instant.
  expect(
    isInstant(b.range.start),
    `range.start is an offset-bearing instant: ${b.range.start}`,
  ).toBe(true);
  expect(isInstant(b.range.end), `range.end is an offset-bearing instant: ${b.range.end}`).toBe(
    true,
  );
  // Strict: the contract is end > start (no zero-length bookings).
  expect(
    Date.parse(b.range.end) > Date.parse(b.range.start),
    `end > start (${b.range.start}..${b.range.end})`,
  ).toBe(true);
  expect(VALID_STATUSES, `status in enum: ${b.status}`).toContain(b.status);
  expect('raw' in b, 'booking has raw escape hatch').toBe(true);
}

function assertCanonical(provider: ProviderId, result: any): void {
  if (result == null) return;
  if (Array.isArray(result)) {
    for (const slot of result) {
      if (slot && typeof slot === 'object' && 'start' in slot && 'end' in slot) {
        expect(
          isInstant(slot.start),
          `slot.start is an offset-bearing instant: ${slot.start}`,
        ).toBe(true);
        expect(isInstant(slot.end), `slot.end is an offset-bearing instant: ${slot.end}`).toBe(
          true,
        );
        expect(Date.parse(slot.end) > Date.parse(slot.start), `slot end > start`).toBe(true);
      }
    }
    return;
  }
  if (typeof result === 'object' && Array.isArray(result.bookings)) {
    for (const b of result.bookings) assertCanonicalBooking(b, provider);
    return;
  }
  if (typeof result === 'object' && 'provider' in result && 'range' in result) {
    assertCanonicalBooking(result, provider);
  }
}

/** Drive every method of an adapter against mocked HTTP and assert the
 *  canonical contract holds — the shared test kit every adapter runs. */
export function runConformance(config: ConformanceConfig): void {
  describe(`conformance: ${config.provider}`, () => {
    let agent: MockAgent;
    let previous: Dispatcher;

    beforeEach(() => {
      previous = getGlobalDispatcher();
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
    });

    afterEach(async () => {
      setGlobalDispatcher(previous);
      await agent.close();
    });

    for (const c of config.cases) {
      it(c.name, async () => {
        agent
          .get(config.origin)
          .intercept({ path: (p) => pathname(p).startsWith(c.path), method: c.method })
          .reply(c.status ?? 200, body(c.reply), { headers: JSON_HEADERS });

        const result = await c.run(config.makeClient());
        assertCanonical(config.provider, result);
        c.check?.(result);
        agent.assertNoPendingInterceptors();
      });
    }

    describe('error mapping', () => {
      const table: Array<[number, string]> = [
        [400, 'INVALID_INPUT'],
        [422, 'INVALID_INPUT'],
        [401, 'AUTH'],
        [403, 'FORBIDDEN'],
        [404, 'NOT_FOUND'],
        [410, 'NOT_FOUND'],
        [409, 'CONFLICT'],
        [429, 'RATE_LIMIT'],
      ];
      for (const [status, code] of table) {
        it(`HTTP ${status} -> ${code}`, async () => {
          agent
            .get(config.origin)
            .intercept({
              path: (p) => pathname(p).startsWith(config.errorProbe.path),
              method: config.errorProbe.method,
            })
            .reply(
              status,
              JSON.stringify({
                error: { message: 'boom' },
                errors: [{ code: 'X', detail: 'boom' }],
              }),
              { headers: status === 429 ? { ...JSON_HEADERS, 'retry-after': '2' } : JSON_HEADERS },
            );

          const err = await config.errorProbe
            .run(config.makeClient())
            .then(() => null)
            .catch((e) => e);
          expect(err, 'method should reject').toBeTruthy();
          expect(err.code).toBe(code);
          if (status === 429) expect(err.retryAfterMs).toBe(2000);
        });
      }
    });

    it('capability↔method: unsupported availability throws UNSUPPORTED', async () => {
      const client = config.makeClient();
      if (client.capabilities.availability) return;
      const err = await client
        .searchAvailability({
          range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
        })
        .then(() => null)
        .catch((e) => e);
      expect(err?.code).toBe('UNSUPPORTED');
    });
  });
}
