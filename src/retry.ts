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
    // Read-only and safe to retry. Note this retries the transient faults the
    // probe rethrows (network, 5xx, rate limit); a dead connection is returned,
    // not thrown, so it is reported on the first attempt rather than retried.
    checkConnection: () => run(() => client.checkConnection(), true),
    ...(client.listServices
      ? { listServices: (query) => run(() => client.listServices!(query), true) }
      : {}),
    ...(client.listStaff
      ? { listStaff: (query) => run(() => client.listStaff!(query), true) }
      : {}),
    // Reads, so safe to retry.
    ...(client.listCalendars
      ? { listCalendars: (query) => run(() => client.listCalendars!(query), true) }
      : {}),
    ...(client.listCategories
      ? { listCategories: () => run(() => client.listCategories!(), true) }
      : {}),
    ...(client.getBusinessHours
      ? { getBusinessHours: () => run(() => client.getBusinessHours!(), true) }
      : {}),
    ...(client.listClasses
      ? { listClasses: (query) => run(() => client.listClasses!(query), true) }
      : {}),
    ...(client.getClass ? { getClass: (id) => run(() => client.getClass!(id), true) } : {}),
    // An enrollment is a booking create: same rule as createBooking.
    ...(client.enrollInClass
      ? {
          enrollInClass: (input) =>
            run(
              () => client.enrollInClass!(input),
              options.unsafeRetryCreates === true || input.idempotencyKey !== undefined,
            ),
        }
      : {}),
    // A sync page is a read: re-asking with the same token returns the same
    // changes, so it is safe to retry.
    ...(client.syncBookings
      ? { syncBookings: (query) => run(() => client.syncBookings!(query), true) }
      : {}),
    // Creating (or, on Google, renewing = re-creating) a watch is not
    // idempotent: a retry after a watch that actually registered leaves a
    // second channel delivering duplicate notifications until it expires.
    ...(client.watchBookings
      ? { watchBookings: (input) => run(() => client.watchBookings!(input), false) }
      : {}),
    ...(client.renewWatch
      ? { renewWatch: (watch, input) => run(() => client.renewWatch!(watch, input), false) }
      : {}),
    // Stopping twice ends in the same state.
    ...(client.stopWatch
      ? { stopWatch: (watch) => run(() => client.stopWatch!(watch), true) }
      : {}),
    // Creates are NOT auto-retried: neither provider write takes an idempotency
    // key from the caller, so a network retry after a create that actually
    // succeeded would duplicate the service or staff member. Same reasoning as
    // createBooking without an idempotencyKey, and as customers.findOrCreate.
    ...(client.createService
      ? { createService: (input) => run(() => client.createService!(input), false) }
      : {}),
    ...(client.createStaff
      ? { createStaff: (input) => run(() => client.createStaff!(input), false) }
      : {}),
    // Updates are idempotent -- the same body applied twice lands the same
    // state -- so they are safe to retry.
    ...(client.updateService
      ? { updateService: (id, input) => run(() => client.updateService!(id, input), true) }
      : {}),
    ...(client.setServiceActive
      ? { setServiceActive: (id, active) => run(() => client.setServiceActive!(id, active), true) }
      : {}),
    ...(client.updateStaff
      ? { updateStaff: (id, input) => run(() => client.updateStaff!(id, input), true) }
      : {}),
    ...(client.setStaffActive
      ? { setStaffActive: (id, active) => run(() => client.setStaffActive!(id, active), true) }
      : {}),
    // By-id reads, so safe to retry.
    ...(client.getService ? { getService: (id) => run(() => client.getService!(id), true) } : {}),
    ...(client.getStaff ? { getStaff: (id) => run(() => client.getStaff!(id), true) } : {}),
    // Deleting twice ends in the same state (same rule as cancelBooking), and
    // assignment is idempotent by contract: already (un)assigned is not an error.
    ...(client.deleteService
      ? { deleteService: (id) => run(() => client.deleteService!(id), true) }
      : {}),
    ...(client.deleteStaff
      ? { deleteStaff: (id) => run(() => client.deleteStaff!(id), true) }
      : {}),
    ...(client.assignStaffToService
      ? {
          assignStaffToService: (serviceId, staffId) =>
            run(() => client.assignStaffToService!(serviceId, staffId), true),
        }
      : {}),
    ...(client.unassignStaffFromService
      ? {
          unassignStaffFromService: (serviceId, staffId) =>
            run(() => client.unassignStaffFromService!(serviceId, staffId), true),
        }
      : {}),
    ...(client.customers
      ? {
          customers: {
            // findOrCreate can perform a non-idempotent create (a network retry
            // after a create that actually succeeded would duplicate the
            // customer), so it is NOT auto-retried.
            findOrCreate: (customer) => run(() => client.customers!.findOrCreate(customer), false),
            // Reads, updates and deletes end in the same state when repeated;
            // a plain create does not (it always creates), so it is not retried.
            ...(client.customers.list
              ? { list: (query) => run(() => client.customers!.list!(query), true) }
              : {}),
            ...(client.customers.get
              ? { get: (id) => run(() => client.customers!.get!(id), true) }
              : {}),
            ...(client.customers.create
              ? { create: (input) => run(() => client.customers!.create!(input), false) }
              : {}),
            ...(client.customers.update
              ? { update: (id, input) => run(() => client.customers!.update!(id, input), true) }
              : {}),
            ...(client.customers.delete
              ? { delete: (id) => run(() => client.customers!.delete!(id), true) }
              : {}),
          },
        }
      : {}),
    ...(client.getCalendar
      ? { getCalendar: (id) => run(() => client.getCalendar!(id), true) }
      : {}),
    // Creating a calendar twice makes two calendars, so it is not retried;
    // renaming and deleting end in the same state when repeated.
    ...(client.createCalendar
      ? { createCalendar: (input) => run(() => client.createCalendar!(input), false) }
      : {}),
    ...(client.updateCalendar
      ? { updateCalendar: (id, input) => run(() => client.updateCalendar!(id, input), true) }
      : {}),
    ...(client.deleteCalendar
      ? { deleteCalendar: (id) => run(() => client.deleteCalendar!(id), true) }
      : {}),
  };
  return wrapped;
}
