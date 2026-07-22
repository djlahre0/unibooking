import type { BookingClient, CreateBookingInput } from './types';
import { isRetryable, isUnibookingError, type UnibookingError } from './errors';

export interface RetryOptions {
  /** Max retry attempts after the first try. Default 3. */
  retries?: number;
  /** Base backoff before exponential growth, in ms. Default 200. */
  baseDelayMs?: number;
  /** Backoff ceiling, in ms. Default 10000. */
  maxDelayMs?: number;
  /** Exponential factor. Default 2. */
  factor?: number;
  /** Add random jitter to backoff. Default true. */
  jitter?: boolean;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override which errors retry. Default: RATE_LIMIT/UPSTREAM/NETWORK/TIMEOUT. */
  shouldRetry?: (err: UnibookingError, attempt: number) => boolean;
  /**
   * Retry `createBooking` even without an `idempotencyKey`. Off by default,
   * because retrying a create that may have already succeeded can double-book.
   */
  unsafeRetryCreates?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a client so transient failures retry with exponential backoff. Honors
 * `retryAfterMs` from RATE_LIMIT errors. `createBooking` is retried only when it
 * carries an `idempotencyKey` (or `unsafeRetryCreates` is set), so a retry can't
 * silently create a duplicate booking.
 */
export function withRetry(client: BookingClient, options: RetryOptions = {}): BookingClient {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? ((err) => isRetryable(err.code));

  async function run<T>(fn: () => Promise<T>, retryThis: boolean): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (
          !retryThis ||
          !isUnibookingError(err) ||
          attempt >= retries ||
          !shouldRetry(err, attempt)
        ) {
          throw err;
        }
        const backoff = Math.min(maxDelayMs, baseDelayMs * factor ** attempt);
        const jittered = jitter ? backoff * (0.5 + Math.random() * 0.5) : backoff;
        // A server-supplied Retry-After is honored, but still capped by
        // maxDelayMs so a hostile/mis-set header can't stall the caller for hours.
        const delay =
          err.retryAfterMs !== undefined ? Math.min(maxDelayMs, err.retryAfterMs) : jittered;
        await sleep(delay);
        attempt++;
      }
    }
  }

  const wrapped: BookingClient = {
    id: client.id,
    capabilities: client.capabilities,
    createBooking: (input: CreateBookingInput) =>
      run(
        () => client.createBooking(input),
        options.unsafeRetryCreates === true || input.idempotencyKey !== undefined,
      ),
    getBooking: (id) => run(() => client.getBooking(id), true),
    updateBooking: (id, input) => run(() => client.updateBooking(id, input), true),
    cancelBooking: (id, opts) => run(() => client.cancelBooking(id, opts), true),
    listBookings: (query) => run(() => client.listBookings(query), true),
    searchAvailability: (query) => run(() => client.searchAvailability(query), true),
    ...(client.customers
      ? {
          customers: {
            // findOrCreate can perform a non-idempotent create (a network retry
            // after a create that actually succeeded would duplicate the
            // customer), so it is NOT auto-retried.
            findOrCreate: (customer) => run(() => client.customers!.findOrCreate(customer), false),
          },
        }
      : {}),
  };
  return wrapped;
}
