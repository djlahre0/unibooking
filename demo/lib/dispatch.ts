import { withRetry, collectAll, listAll, UnibookingError } from 'unibooking';
import type { BookingClient } from 'unibooking';

/**
 * The set of client-requiring operations. Shared verbatim by both transports:
 * the direct transport runs dispatch() in the browser, the proxy route runs the
 * identical dispatch() on the server — so the two paths can never drift apart.
 */
export type Op =
  | 'createBooking'
  | 'getBooking'
  | 'updateBooking'
  | 'cancelBooking'
  | 'listBookings'
  | 'searchAvailability'
  | 'findOrCreate'
  | 'withRetryList'
  | 'collectAll'
  | 'listAll';

export const OPS: readonly Op[] = [
  'createBooking',
  'getBooking',
  'updateBooking',
  'cancelBooking',
  'listBookings',
  'searchAvailability',
  'findOrCreate',
  'withRetryList',
  'collectAll',
  'listAll',
];

const RANGE = (a: { start: string; end: string }) => ({ start: a.start, end: a.end });

/**
 * Run one operation against a BookingClient. Returns the success payload or
 * throws (UnibookingError for domain failures) — callers wrap via serializeError.
 */
export async function dispatch(
  client: BookingClient,
  op: Op,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
): Promise<unknown> {
  switch (op) {
    case 'createBooking':
      return client.createBooking({
        title: args.title,
        range: { start: args.start, end: args.end },
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        ...(args.staffId ? { staffId: args.staffId } : {}),
        ...(args.customerName || args.customerEmail
          ? { customer: { name: args.customerName, email: args.customerEmail } }
          : {}),
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      });

    case 'getBooking':
      return client.getBooking(args.bookingId);

    case 'updateBooking': {
      const input = args.input ?? {};
      const updateInput: Record<string, unknown> = {};
      if (input.title !== undefined) updateInput.title = input.title;
      if (input.start || input.end) {
        if (!input.start || !input.end) {
          throw new UnibookingError({
            provider: client.id,
            code: 'INVALID_INPUT',
            message: 'Both start and end are required when updating the time range.',
          });
        }
        updateInput.range = { start: input.start, end: input.end };
      }
      if (input.staffId !== undefined) updateInput.staffId = input.staffId;
      if (input.serviceId !== undefined) updateInput.serviceId = input.serviceId;
      return client.updateBooking(args.bookingId, updateInput);
    }

    case 'cancelBooking':
      await client.cancelBooking(args.bookingId, args.reason ? { reason: args.reason } : undefined);
      return { cancelled: true, bookingId: args.bookingId };

    case 'listBookings':
      return client.listBookings({
        range: RANGE(args),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.pageToken ? { pageToken: args.pageToken } : {}),
      });

    case 'searchAvailability':
      return client.searchAvailability({
        range: RANGE(args),
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        ...(args.staffId ? { staffId: args.staffId } : {}),
      });

    case 'findOrCreate':
      if (!client.customers) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider does not support customer operations.',
        });
      }
      return { customerId: await client.customers.findOrCreate(args) };

    case 'withRetryList': {
      const retryConfig = { retries: 2, baseDelayMs: 100, maxDelayMs: 1000 };
      const retried = withRetry(client, retryConfig);
      const result = await retried.listBookings({ range: RANGE(args) });
      return {
        note: 'withRetry wrapped client used — transient errors auto-retry with exponential backoff',
        retryConfig,
        result,
      };
    }

    case 'collectAll': {
      const all = await collectAll(client, { range: RANGE(args) }, { maxPages: 5 });
      return {
        note: 'collectAll auto-paginates across all pages (maxPages: 5)',
        totalBookings: all.length,
        bookings: all,
      };
    }

    case 'listAll': {
      const bookings: unknown[] = [];
      let count = 0;
      for await (const b of listAll(client, { range: RANGE(args) }, { maxPages: 3 })) {
        bookings.push(b);
        count++;
        if (count >= 20) break; // safety cap for demo
      }
      return {
        note: 'listAll yields bookings one-by-one via AsyncGenerator (capped at 20 for demo)',
        count: bookings.length,
        bookings,
      };
    }
  }
}
