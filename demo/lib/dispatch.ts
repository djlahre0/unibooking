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
  | 'checkConnection'
  | 'listServices'
  | 'listStaff'
  | 'listCategories'
  | 'getBusinessHours'
  | 'listCalendars'
  | 'listClasses'
  | 'getClass'
  | 'enrollInClass'
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
  'checkConnection',
  'listServices',
  'listStaff',
  'listCategories',
  'getBusinessHours',
  'listCalendars',
  'listClasses',
  'getClass',
  'enrollInClass',
  'findOrCreate',
  'withRetryList',
  'collectAll',
  'listAll',
];

/** Upper bound on calendar-list pages fetched for one `listCalendars`. */
const MAX_CALENDAR_PAGES = 5;

// `timezone` is an IANA name for display, but some providers genuinely need it:
// Setmore and Wix return offset-less slot times that cannot be anchored without
// one, and reject an availability query that omits it.
const RANGE = (a: { start: string; end: string; timezone?: string }) => ({
  start: a.start,
  end: a.end,
  ...(a.timezone ? { timezone: a.timezone } : {}),
});

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

    case 'searchAvailability': {
      // Google's freeBusy returns busy intervals, not bookable slots, so its
      // adapter needs a positive duration to size each one and rejects the
      // query without it. Coerced and bounds-checked here because a blank form
      // field arrives as '' (Number('') === 0), and passing 0 on would trip
      // the adapter's own guard with a more confusing message than sending
      // nothing at all.
      const duration = Number(args.durationMinutes);
      return client.searchAvailability({
        range: RANGE(args),
        ...(args.serviceId ? { serviceId: args.serviceId } : {}),
        ...(args.staffId ? { staffId: args.staffId } : {}),
        ...(Number.isFinite(duration) && duration > 0 ? { durationMinutes: duration } : {}),
      });
    }

    case 'checkConnection':
      // Present on every adapter, so no capability guard. Note this resolves
      // `{ ok: false }` for dead credentials rather than throwing — only a
      // transient fault reaches serializeError.
      return client.checkConnection();

    case 'listServices':
      if (!client.listServices) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider does not expose a service catalog.',
        });
      }
      return client.listServices({
        ...(args?.staffId ? { staffId: args.staffId } : {}),
        ...(args?.categoryId ? { categoryId: args.categoryId } : {}),
        ...(args?.limit ? { limit: Number(args.limit) } : {}),
        ...(args?.pageToken ? { pageToken: args.pageToken } : {}),
      });

    case 'listStaff':
      if (!client.listStaff) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider does not expose a staff directory.',
        });
      }
      return client.listStaff({
        ...(args?.serviceId ? { serviceId: args.serviceId } : {}),
        ...(args?.limit ? { limit: Number(args.limit) } : {}),
        ...(args?.pageToken ? { pageToken: args.pageToken } : {}),
      });

    case 'listCategories':
      if (!client.listCategories) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider does not expose service categories.',
        });
      }
      return client.listCategories();

    case 'getBusinessHours':
      if (!client.getBusinessHours) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider does not expose business hours.',
        });
      }
      return client.getBusinessHours();

    // Every page, capped: the explorer searches the result for the calendar
    // a connection targets, which can sit on any page (providers don't
    // promise to list the primary one first).
    case 'listCalendars': {
      if (!client.listCalendars) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider has no calendar list.',
        });
      }
      const calendars = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_CALENDAR_PAGES; page++) {
        const res = await client.listCalendars(pageToken ? { pageToken } : {});
        calendars.push(...res.calendars);
        pageToken = res.nextPageToken;
        if (!pageToken) break;
      }
      return { calendars };
    }

    case 'listClasses':
      if (!client.listClasses) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider has no group-class concept.',
        });
      }
      return client.listClasses({
        ...(args?.start && args?.end ? { range: { start: args.start, end: args.end } } : {}),
        ...(args?.staffId ? { staffId: args.staffId } : {}),
        ...(args?.serviceId ? { serviceId: args.serviceId } : {}),
        ...(args?.limit ? { limit: Number(args.limit) } : {}),
        ...(args?.pageToken ? { pageToken: args.pageToken } : {}),
      });

    case 'getClass':
      if (!client.getClass) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider has no group-class concept.',
        });
      }
      return client.getClass(args.classId);

    case 'enrollInClass':
      if (!client.enrollInClass) {
        throw new UnibookingError({
          provider: client.id,
          code: 'UNSUPPORTED',
          message: 'This provider does not support class enrollment.',
        });
      }
      return client.enrollInClass({
        classId: args.classId,
        customer: {
          ...(args?.customerId ? { id: args.customerId } : {}),
          ...(args?.customerName ? { name: args.customerName } : {}),
          ...(args?.customerEmail ? { email: args.customerEmail } : {}),
          ...(args?.customerPhone ? { phone: args.customerPhone } : {}),
        },
        ...(args?.allowWaitlist ? { allowWaitlist: true } : {}),
        ...(args?.notes ? { notes: args.notes } : {}),
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
