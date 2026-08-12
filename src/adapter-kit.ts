import type {
  AdapterFactory,
  BookingClient,
  Capabilities,
  ClientOptions,
  ConnectionStatus,
  CredsInput,
  CustomerOps,
  ListServicesQuery,
  ListStaffQuery,
  ProviderCredentials,
  ProviderId,
} from './types';
import { createHttp, type AuthFn, type HttpConfig, type HttpContext } from './http';
import { UnibookingError, type ErrorCode } from './errors';
import { sortSlots } from './availability';

/** The method set an adapter implements (everything on BookingClient except the
 *  static `id`/`capabilities`, which `defineAdapter` attaches). */
export interface AdapterMethods {
  createBooking: BookingClient['createBooking'];
  getBooking: BookingClient['getBooking'];
  updateBooking: BookingClient['updateBooking'];
  cancelBooking: BookingClient['cancelBooking'];
  listBookings: BookingClient['listBookings'];
  searchAvailability: BookingClient['searchAvailability'];
  checkConnection: BookingClient['checkConnection'];
  listServices?: NonNullable<BookingClient['listServices']>;
  listStaff?: NonNullable<BookingClient['listStaff']>;
  createService?: NonNullable<BookingClient['createService']>;
  updateService?: NonNullable<BookingClient['updateService']>;
  setServiceActive?: NonNullable<BookingClient['setServiceActive']>;
  createStaff?: NonNullable<BookingClient['createStaff']>;
  updateStaff?: NonNullable<BookingClient['updateStaff']>;
  setStaffActive?: NonNullable<BookingClient['setStaffActive']>;
  customers?: CustomerOps;
}

export interface AdapterDef<TCreds extends ProviderCredentials> {
  id: ProviderId;
  capabilities: Capabilities;
  baseUrl: string;
  auth: AuthFn<TCreds>;
  requestIdHeader?: string;
  parseError?: HttpConfig<TCreds>['parseError'];
  /** Build the method implementations against a ready HTTP context. */
  build: (http: HttpContext<TCreds>) => AdapterMethods;
}

/** Wire an adapter definition into a callable `AdapterFactory`. */
export function defineAdapter<TCreds extends ProviderCredentials>(
  def: AdapterDef<TCreds>,
): AdapterFactory<TCreds> {
  const impl = (creds: CredsInput<TCreds>, options?: ClientOptions): BookingClient => {
    const http = createHttp<TCreds>({
      provider: def.id,
      baseUrl: options?.baseUrl ?? def.baseUrl,
      creds,
      auth: def.auth,
      options,
      ...(def.requestIdHeader !== undefined ? { requestIdHeader: def.requestIdHeader } : {}),
      ...(def.parseError !== undefined ? { parseError: def.parseError } : {}),
    });
    const m = def.build(http);
    return {
      id: def.id,
      capabilities: def.capabilities,
      createBooking: m.createBooking,
      getBooking: m.getBooking,
      updateBooking: m.updateBooking,
      cancelBooking: m.cancelBooking,
      // `ListBookingsQuery.status` is documented without caveat, but most
      // providers have no status filter to forward it to — Google, Square,
      // Mindbody, Setmore, Acuity and Vagaro all returned cancelled bookings
      // from a `status: 'confirmed'` query. Adapters forward whatever their
      // provider supports (it is cheaper upstream and keeps pages dense); this
      // is the backstop that makes the documented filter true everywhere.
      // Re-filtering an already-filtered list is a no-op, so adapters that
      // handle it themselves are unaffected.
      listBookings: async (query) => {
        const result = await m.listBookings(query);
        if (query.status === undefined) return result;
        // Keep `nextPageToken` even when a page filters down to nothing: the
        // matches may be on a later page, and dropping the token would end
        // pagination early. `listAll` already walks past empty pages.
        return { ...result, bookings: result.bookings.filter((b) => b.status === query.status) };
      },
      // Chronological order is part of the canonical result, not something each
      // adapter re-derives — see `sortSlots` for why provider order isn't it.
      searchAvailability: async (query) => sortSlots(await m.searchAvailability(query)),
      checkConnection: m.checkConnection,
      // `limit` is documented on both queries without caveat, but several
      // providers expose no page-size parameter at all (Setmore, Acuity,
      // Phorest, Bookeo, Boulevard) and returned their entire catalog to a
      // caller who asked for ten. Same backstop, and same reasoning, as the
      // `status` filter above.
      //
      // Truncation is applied ONLY on a terminal page. If the provider handed
      // back a cursor it is paginating for itself, and slicing there would
      // silently strip the items between the cut and the next page — the caller
      // would page forward and never see them.
      ...(m.listServices
        ? {
            listServices: async (query?: ListServicesQuery) => {
              const result = await m.listServices!(query);
              return capPage(result, 'services', query?.limit);
            },
          }
        : {}),
      ...(m.listStaff
        ? {
            listStaff: async (query?: ListStaffQuery) => {
              const result = await m.listStaff!(query);
              return capPage(result, 'staff', query?.limit);
            },
          }
        : {}),
      ...(m.createService ? { createService: m.createService } : {}),
      ...(m.updateService ? { updateService: m.updateService } : {}),
      ...(m.setServiceActive ? { setServiceActive: m.setServiceActive } : {}),
      ...(m.createStaff ? { createStaff: m.createStaff } : {}),
      ...(m.updateStaff ? { updateStaff: m.updateStaff } : {}),
      ...(m.setStaffActive ? { setStaffActive: m.setStaffActive } : {}),
      ...(m.customers ? { customers: m.customers } : {}),
    };
  };
  return Object.assign(impl, { id: def.id, capabilities: def.capabilities });
}

/**
 * Trim bookings to the canonical range.
 *
 * Several list endpoints take whole DATES rather than instants — Acuity's
 * `minDate`/`maxDate`, Phorest's `from_date`/`to_date`, Setmore's
 * `startDate`/`endDate`, Zenoti's date pair — so they answer with the entire
 * start and end days no matter what times were asked for. Vagaro is worse: its
 * endpoint takes no window at all and returns the customer's whole history.
 *
 * Same half-open convention as `slotsWithinRange`: kept when the booking
 * *starts* at or after `range.start` and strictly before `range.end`. Note this
 * is a deliberate choice of "starts within" over "overlaps" — it matches what
 * the date-granular providers are being asked for and keeps paging honest. It is
 * applied per-adapter rather than in `defineAdapter` precisely because providers
 * that filter server-side (Google, Outlook, Graph) return bookings that merely
 * *overlap* the window, and re-trimming those at the boundary would discard an
 * in-progress booking the provider deliberately included.
 */
export function bookingsWithinRange<T extends { range: { start: string } }>(
  bookings: T[],
  range: { start: string; end: string },
): T[] {
  const from = Date.parse(range.start);
  const to = Date.parse(range.end);
  if (Number.isNaN(from) || Number.isNaN(to)) return bookings;
  return bookings.filter((b) => {
    const s = Date.parse(b.range.start);
    return !Number.isNaN(s) && s >= from && s < to;
  });
}

/** Codes that mean "these credentials no longer work". Everything else is a
 *  fault, not a verdict on the connection. */
const DEAD_CONNECTION_CODES = new Set<ErrorCode>(['AUTH', 'FORBIDDEN', 'NOT_FOUND']);

/**
 * Run a liveness probe and classify the outcome.
 *
 * A dead connection is the expected answer to `checkConnection`, so it is
 * returned rather than thrown. A network blip, timeout, rate limit or 5xx is
 * NOT evidence that a salon revoked access — those rethrow, so a consumer
 * cannot mistake a transient failure for a revoked integration and disconnect
 * a healthy one.
 */
export async function probeConnection(
  _provider: ProviderId,
  probe: () => Promise<{ account?: ConnectionStatus['account']; raw: unknown }>,
): Promise<ConnectionStatus> {
  try {
    const { account, raw } = await probe();
    return { ok: true, ...(account ? { account } : {}), raw };
  } catch (e) {
    if (e instanceof UnibookingError && DEAD_CONNECTION_CODES.has(e.code)) {
      return {
        ok: false,
        reason: e.code as NonNullable<ConnectionStatus['reason']>,
        message: e.message,
        raw: e,
      };
    }
    throw e;
  }
}

/** Apply `limit` to a list page whose provider had no page-size parameter.
 *
 *  Only trims a TERMINAL page. When the provider returned a cursor it is paging
 *  for itself, and slicing there would silently strip the items between the cut
 *  and the next page — the caller would page forward and never see them. */
function capPage<K extends string, T>(
  result: { [P in K]: T[] } & { nextPageToken?: string },
  key: K,
  limit: number | undefined,
): typeof result {
  if (limit === undefined || limit < 0) return result;
  if (result.nextPageToken !== undefined) return result;
  const list = result[key];
  if (list.length <= limit) return result;
  return { ...result, [key]: list.slice(0, limit) };
}

/** Parse an ISO-8601 duration (`PT1H30M`, `PT45M`) to minutes.
 *
 *  Graph and Bookeo both express service durations this way. Returns undefined
 *  for anything unparseable or non-positive rather than a misleading zero. */
export function minutesFromIso8601Duration(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(v.trim());
  if (!m) return undefined;
  const [, d, h, min, sec] = m;
  const total =
    Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(min ?? 0) + Number(sec ?? 0) / 60;
  return total > 0 ? total : undefined;
}

/** Throw a consistent UNSUPPORTED error (for capabilities a provider lacks). */
export function unsupported(provider: ProviderId, capability: string): never {
  throw new UnibookingError({
    provider,
    code: 'UNSUPPORTED',
    message: `${provider} does not support ${capability}`,
  });
}

// --- Response validation helpers -------------------------------------------
// Adapters map untyped provider JSON. These assert the fields we actually read
// and throw UPSTREAM("unexpected response shape") instead of silently emitting
// a malformed Booking.

export function asRecord(v: unknown, provider: ProviderId, ctx: string): Record<string, any> {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, any>;
  }
  throw new UnibookingError({
    provider,
    code: 'UPSTREAM',
    message: `${ctx}: expected an object, got ${Array.isArray(v) ? 'array' : typeof v}`,
  });
}

export function asArray(v: unknown, provider: ProviderId, ctx: string): any[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  throw new UnibookingError({
    provider,
    code: 'UPSTREAM',
    message: `${ctx}: expected an array, got ${typeof v}`,
  });
}

/** Decimal price (`"45.00"`, `45.5`) → integer minor units.
 *
 *  Several providers return prices as decimal strings or floats. Rounds rather
 *  than truncates so `"45.005"` cannot silently lose a cent downward, and
 *  returns undefined for anything unparseable or negative rather than emitting a
 *  bogus amount. The currency is always the caller's problem — a `Money` without
 *  one is unusable, so `price` is omitted rather than guessed. */
export function decimalToMinorUnits(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

export function reqString(v: unknown, provider: ProviderId, ctx: string): string {
  if (typeof v === 'string' && v.length > 0) return v;
  throw new UnibookingError({
    provider,
    code: 'UPSTREAM',
    message: `${ctx}: expected a non-empty string, got ${typeof v}`,
  });
}
