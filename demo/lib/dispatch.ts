import { withRetry, collectAll, listAll, UnibookingError } from 'unibooking';
import type { BookingClient } from 'unibooking';
import { CALENDAR_PROVIDERS, markCancelled, setEventStatus, type EventStatus } from './cancel-event';

/**
 * The set of client-requiring operations. Shared verbatim by both transports:
 * the direct transport runs dispatch() in the browser, the proxy route runs the
 * identical dispatch() on the server, so the two paths can never drift apart.
 */
export type Op =
  | 'createBooking'
  | 'getBooking'
  | 'updateBooking'
  | 'cancelBooking'
  | 'markCancelled'
  | 'listBookings'
  | 'searchAvailability'
  | 'checkConnection'
  | 'listServices'
  | 'listStaff'
  | 'getService'
  | 'getStaff'
  | 'createService'
  | 'updateService'
  | 'setServiceActive'
  | 'deleteService'
  | 'createStaff'
  | 'updateStaff'
  | 'setStaffActive'
  | 'deleteStaff'
  | 'assignStaff'
  | 'unassignStaff'
  | 'listCategories'
  | 'getBusinessHours'
  | 'listCalendars'
  | 'listClasses'
  | 'getClass'
  | 'enrollInClass'
  | 'findOrCreate'
  | 'listCustomers'
  | 'getCalendar'
  | 'createCalendar'
  | 'updateCalendar'
  | 'deleteCalendar'
  | 'getCustomer'
  | 'createCustomer'
  | 'updateCustomer'
  | 'deleteCustomer'
  | 'withRetryList'
  | 'collectAll'
  | 'listAll';

export const OPS: readonly Op[] = [
  'createBooking',
  'getBooking',
  'updateBooking',
  'cancelBooking',
  'markCancelled',
  'listBookings',
  'searchAvailability',
  'checkConnection',
  'listServices',
  'listStaff',
  'getService',
  'getStaff',
  'createService',
  'updateService',
  'setServiceActive',
  'deleteService',
  'createStaff',
  'updateStaff',
  'setStaffActive',
  'deleteStaff',
  'assignStaff',
  'unassignStaff',
  'listCategories',
  'getBusinessHours',
  'listCalendars',
  'listClasses',
  'getClass',
  'enrollInClass',
  'findOrCreate',
  'listCustomers',
  'getCalendar',
  'createCalendar',
  'updateCalendar',
  'deleteCalendar',
  'getCustomer',
  'createCustomer',
  'updateCustomer',
  'deleteCustomer',
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

/** An optional client method, bound, or UNSUPPORTED naming what is missing. */
type Fn = (...a: never[]) => Promise<unknown>;
function need<K extends keyof BookingClient>(
  client: BookingClient,
  method: K,
  what: string,
): NonNullable<BookingClient[K]> {
  const fn = client[method];
  if (typeof fn !== 'function') {
    throw new UnibookingError({
      provider: client.id,
      code: 'UNSUPPORTED',
      message: `This provider does not support ${what}.`,
    });
  }
  return (fn as Fn).bind(client) as NonNullable<BookingClient[K]>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function calendarInput(a: any) {
  return {
    ...(a.name ? { name: String(a.name) } : {}),
    ...(a.timezone ? { timezone: String(a.timezone) } : {}),
    ...(a.description ? { description: String(a.description) } : {}),
    ...(a.color ? { color: String(a.color) } : {}),
  };
}

/** A `customers.*` method, bound, or UNSUPPORTED naming what is missing. */
function customerOp<K extends 'list' | 'get' | 'create' | 'update' | 'delete'>(
  client: BookingClient,
  method: K,
  what: string,
): NonNullable<NonNullable<BookingClient['customers']>[K]> {
  const fn = client.customers?.[method];
  if (typeof fn !== 'function') {
    throw new UnibookingError({
      provider: client.id,
      code: 'UNSUPPORTED',
      message: `This provider does not support ${what}.`,
    });
  }
  return (fn as Fn).bind(client.customers) as NonNullable<
    NonNullable<BookingClient['customers']>[K]
  >;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function customerInput(a: any) {
  return {
    ...(a.name ? { name: String(a.name) } : {}),
    ...(a.email ? { email: String(a.email) } : {}),
    ...(a.phone ? { phone: String(a.phone) } : {}),
    ...(a.note ? { note: String(a.note) } : {}),
  };
}

/** Form fields → a service create/update input. Blank fields are omitted, so
 *  an update only touches what was filled in. Price is typed in major units
 *  (e.g. 45.00) and sent as integer minor units. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serviceInput(a: any) {
  const minutes = Number(a.durationMinutes);
  const price = Number(a.price);
  return {
    ...(a.name ? { name: String(a.name) } : {}),
    ...(a.description ? { description: String(a.description) } : {}),
    ...(a.durationMinutes && Number.isFinite(minutes) && minutes > 0
      ? { durationMinutes: minutes }
      : {}),
    ...(a.price !== undefined && a.price !== '' && Number.isFinite(price) && a.currency
      ? { price: { amount: Math.round(price * 100), currency: String(a.currency).toUpperCase() } }
      : {}),
    ...activeOf(a),
  } as { name: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function staffInput(a: any) {
  return {
    ...(a.name ? { name: String(a.name) } : {}),
    ...(a.email ? { email: String(a.email) } : {}),
    ...(a.phone ? { phone: String(a.phone) } : {}),
    ...activeOf(a),
  } as { name: string };
}

/** `active` from a form ('active'/'inactive', 'true'/'false') or JSON (a
 *  boolean). Absent means "leave the status alone". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function activeOf(a: any): { active?: boolean } {
  const v = a.active ?? a.status;
  if (v === true || v === 'true' || v === 'active') return { active: true };
  if (v === false || v === 'false' || v === 'inactive') return { active: false };
  return {};
}

/**
 * Run one operation against a BookingClient. Returns the success payload or
 * throws (UnibookingError for domain failures): callers wrap via serializeError.
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
        // Calendar Sync writes a marker here so a re-sync recognises its own
        // copies; ignored by providers without a description field.
        ...(args.description ? { description: String(args.description) } : {}),
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
      if (input.status && CALENDAR_PROVIDERS.has(client.id)) {
        // Calendars model status differently per provider (Google deletes a
        // "cancelled" event, Outlook refuses one), so the status goes through
        // setEventStatus after any other change: kept-and-marked cancelled,
        // or confirmed/tentative with a previous cancel undone.
        if (Object.keys(updateInput).length > 0) {
          await client.updateBooking(args.bookingId, updateInput);
        }
        return setEventStatus(client, args.bookingId, input.status as EventStatus);
      }
      if (input.status) updateInput.status = input.status;
      return client.updateBooking(args.bookingId, updateInput);
    }

    case 'cancelBooking':
      await client.cancelBooking(args.bookingId, args.reason ? { reason: args.reason } : undefined);
      return { cancelled: true, bookingId: args.bookingId };

    // Calendar events only: keep the event, marked cancelled (cancel-event.ts).
    case 'markCancelled':
      return markCancelled(client, args.bookingId, args.reason);

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
      // `{ ok: false }` for dead credentials rather than throwing, only a
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

    // ── Staff & services: get, create, update, retire, delete, assign ──
    // Each is optional on BookingClient and gated by its own capability, so
    // a provider without it answers UNSUPPORTED rather than crashing.
    case 'getService':
      return need(client, 'getService', 'looking up a service by id')(args.id);
    case 'getStaff':
      return need(client, 'getStaff', 'looking up a staff member by id')(args.id);
    case 'createService':
      return need(client, 'createService', 'creating services')(serviceInput(args));
    case 'updateService':
      return need(client, 'updateService', 'updating services')(args.id, serviceInput(args));
    case 'setServiceActive':
      return need(
        client,
        'setServiceActive',
        'activating/deactivating services',
      )(args.id, args.active === true || args.active === 'true');
    case 'deleteService':
      await need(client, 'deleteService', 'deleting services')(args.id);
      return { deleted: true, id: args.id };
    case 'createStaff':
      return need(client, 'createStaff', 'creating staff')(staffInput(args));
    case 'updateStaff':
      return need(client, 'updateStaff', 'updating staff')(args.id, staffInput(args));
    case 'setStaffActive':
      return need(
        client,
        'setStaffActive',
        'activating/deactivating staff',
      )(args.id, args.active === true || args.active === 'true');
    case 'deleteStaff':
      await need(client, 'deleteStaff', 'deleting staff')(args.id);
      return { deleted: true, id: args.id };
    case 'assignStaff':
      return need(
        client,
        'assignStaffToService',
        'assigning staff to services',
      )(args.serviceId, args.staffId);
    case 'unassignStaff':
      return need(
        client,
        'unassignStaffFromService',
        'unassigning staff from services',
      )(args.serviceId, args.staffId);

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

    // ── Calendars themselves (calendar providers, `calendarWrite`) ──
    case 'getCalendar':
      return need(client, 'getCalendar', 'looking up a calendar by id')(String(args.id));
    case 'createCalendar':
      return need(client, 'createCalendar', 'creating calendars')(calendarInput(args) as never);
    case 'updateCalendar':
      return need(client, 'updateCalendar', 'updating calendars')(
        String(args.id),
        calendarInput(args),
      );
    case 'deleteCalendar':
      await need(client, 'deleteCalendar', 'deleting calendars')(String(args.id));
      return { deleted: true, id: args.id };

    // ── Client records: each optional on customers, behind its own flag ──
    case 'listCustomers':
      return customerOp(client, 'list', 'listing customers')({
        ...(args?.limit ? { limit: Number(args.limit) } : {}),
        ...(args?.pageToken ? { pageToken: String(args.pageToken) } : {}),
        ...(args?.email ? { email: String(args.email) } : {}),
        ...(args?.phone ? { phone: String(args.phone) } : {}),
      });
    case 'getCustomer':
      return customerOp(client, 'get', 'looking up a customer by id')(String(args.id));
    case 'createCustomer':
      return customerOp(client, 'create', 'creating customers')(customerInput(args));
    case 'updateCustomer':
      return customerOp(client, 'update', 'updating customers')(
        String(args.id),
        customerInput(args),
      );
    case 'deleteCustomer':
      await customerOp(client, 'delete', 'deleting customers')(String(args.id));
      return { deleted: true, id: args.id };

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
        note: 'withRetry wrapped client used: transient errors auto-retry with exponential backoff',
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
