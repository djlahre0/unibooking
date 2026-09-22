/**
 * Canonical types. Intentionally lean — only fields that make sense across
 * (almost) every provider live here. Anything provider-specific goes in `raw`
 * or `providerOptions`, never bolted onto the core shape.
 */

export type ProviderId =
  | 'google'
  | 'apple' // CalDAV
  | 'outlook'
  | 'microsoft_bookings'
  | 'square'
  | 'acuity'
  | 'mindbody'
  | 'bookeo'
  | 'wix' // Wix Bookings (headless REST v2)
  | 'calendly'
  // gated / tier-2 providers implement the same interface, they just require
  // the consumer to complete a manual approval step with the vendor first.
  | 'vagaro'
  | 'zenoti'
  | 'boulevard'
  | 'phorest'
  | 'setmore'
  | 'mangomint';

/** What a provider can actually do. Typed instead of stringly `supports('x')`
 *  so consumers get autocomplete and the compiler catches typos. A method that
 *  needs a capability throws `UnibookingError('UNSUPPORTED')` when it is false. */
export interface Capabilities {
  /** Slot/availability search (e.g. Square) vs plain calendars (Google) that have none. */
  availability: boolean;
  /** Bookings can be assigned to a staff/team member. */
  staff: boolean;
  /** Bookings reference a service/appointment-type. */
  services: boolean;
  /** Signature-verification helpers exist for this provider's webhooks. */
  webhooks: boolean;
  /** `createBooking` honors `idempotencyKey`. */
  idempotency: boolean;
  /** Exposes `client.customers.findOrCreate(...)`. */
  customers: boolean;
  /** `listServices()` is available. Deliberately distinct from `services`,
   *  which only says bookings *reference* a service — a provider can have one
   *  without the other, and several do. */
  serviceCatalog: boolean;
  /** `listStaff()` is available. Distinct from `staff` for the same reason. */
  staffDirectory: boolean;
  /** `createService()` / `updateService()` / `setServiceActive()` are available.
   *  Far rarer than reading — most providers' catalogs are read-only to
   *  third parties. */
  serviceCatalogWrite: boolean;
  /** `createStaff()` / `updateStaff()` / `setStaffActive()` are available. */
  staffDirectoryWrite: boolean;
  /** `listCalendars()` is available: the account's calendars can be enumerated
   *  and one picked to target. Plain calendar providers only — booking
   *  platforms have one schedule per business, not a list of calendars. */
  calendarList: boolean;
}

/** An absolute time span. `start`/`end` are RFC3339 timestamps **with offset**
 *  (unambiguous instants). `timezone` is an IANA name for display only — it
 *  never changes which instant `start`/`end` refer to. Invariant: `end > start`. */
export interface TimeRange {
  start: string;
  end: string;
  timezone?: string;
}

export interface Customer {
  /** Provider-side id, if known. Some providers (e.g. Square) require this to
   *  attach a customer; use `client.customers.findOrCreate` to obtain one. */
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
}

export type BookingStatus =
  'confirmed' | 'pending' | 'cancelled' | 'declined' | 'no_show' | 'completed' | 'unknown';

export interface Booking {
  id: string;
  provider: ProviderId;
  title: string;
  range: TimeRange;
  customer?: Customer;
  staffId?: string;
  serviceId?: string;
  status: BookingStatus;
  createdAt?: string;
  updatedAt?: string;
  /** Free-text notes. Mapped by the calendar providers (google, outlook,
   *  apple); booking platforms leave it unset. */
  description?: string;
  /** Free-text place. Same provider support as `description`. */
  location?: string;
  /** True for a whole-day event. `range` then holds UTC midnights of the
   *  event's calendar dates, end exclusive (`2026-09-21T00:00:00Z` ..
   *  `2026-09-22T00:00:00Z` is the single day 21 Sep). */
  allDay?: boolean;
  /** Everything the provider returned that doesn't map to a canonical field.
   *  Always present so you never lose information. */
  raw: unknown;
}

export interface CreateBookingInput {
  title: string;
  range: TimeRange;
  customer?: Customer;
  staffId?: string;
  serviceId?: string;
  /** Passed to providers that support it (e.g. Square `idempotency_key`) so a
   *  network retry can't double-book. Ignored by providers without support —
   *  check `capabilities.idempotency`. */
  idempotencyKey?: string;
  /** Ask the provider to notify the customer/attendees about the new booking.
   *  Honored only by providers that support it (e.g. Google `sendUpdates`);
   *  ignored elsewhere. Omit to use the provider default. */
  notify?: boolean;
  /** Free-text notes. Honored by calendar providers (google, outlook, apple);
   *  ignored elsewhere, like `notify`. */
  description?: string;
  /** Free-text place. Same provider support as `description`. */
  location?: string;
  /** Create a whole-day event. The event's dates are the calendar dates of
   *  `range.start` and `range.end` as written in their own offsets, end
   *  exclusive — so `2026-09-21T00:00:00+05:30` .. `2026-09-22T00:00:00+05:30`
   *  is the single day 21 Sep. Honored by calendar providers; ignored elsewhere. */
  allDay?: boolean;
  /** Escape hatch for provider-specific required fields
   *  (e.g. Square `appointmentSegments`, Zenoti `roomId`). Shallow-merged into
   *  the outgoing request body. */
  providerOptions?: Record<string, unknown>;
}

export interface UpdateBookingInput {
  title?: string;
  range?: TimeRange;
  status?: BookingStatus;
  staffId?: string;
  serviceId?: string;
  /** Ask the provider to notify the customer/attendees about the change. Honored
   *  only where supported (e.g. Google `sendUpdates`); ignored elsewhere. */
  notify?: boolean;
  /** Replace the notes. An empty string clears them. */
  description?: string;
  /** Replace the place. An empty string clears it. */
  location?: string;
  /** Switch between timed and whole-day. Requires `range`, which is rewritten
   *  in the chosen form (same date rule as `CreateBookingInput.allDay`). When
   *  `range` is given without `allDay`, the event is written as timed. */
  allDay?: boolean;
  providerOptions?: Record<string, unknown>;
}

export interface CancelOptions {
  reason?: string;
  /** Whether the provider should notify the customer. Provider default when omitted. */
  notify?: boolean;
  /** Escape hatch for provider-specific cancel fields (e.g. Square's
   *  `booking_version` for optimistic concurrency). Shallow-merged into the
   *  outgoing request body, same role as `CreateBookingInput.providerOptions`. */
  providerOptions?: Record<string, unknown>;
}

export interface ListBookingsQuery {
  range: TimeRange;
  staffId?: string;
  customerId?: string;
  status?: BookingStatus;
  limit?: number;
  /** Opaque, provider-defined. Pass the previous result's `nextPageToken`. */
  pageToken?: string;
}

export interface ListBookingsResult {
  bookings: Booking[];
  nextPageToken?: string;
}

export interface AvailabilityQuery {
  range: TimeRange;
  serviceId?: string;
  staffId?: string;
  durationMinutes?: number;
  /** Escape hatch for provider-specific availability inputs (e.g. Zenoti's
   *  `guestId`, whose slots are booking-scoped). Same role as
   *  `CreateBookingInput.providerOptions`. */
  providerOptions?: Record<string, unknown>;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
  staffId?: string;
  /** Provider-specific slot data (e.g. Bookeo's `eventId`, needed to book it).
   *  Same escape-hatch role as `Booking.raw`. */
  raw?: unknown;
}

/** A price. Integer minor units avoid float rounding; both fields are required
 *  so a consumer never has to guess a currency. An adapter whose provider omits
 *  the currency leaves `price` undefined rather than assuming one. */
export interface Money {
  /** Integer minor units, e.g. 4500 = $45.00. */
  amount: number;
  /** ISO-4217, e.g. 'USD'. */
  currency: string;
}

export interface Service {
  /** The id that `CreateBookingInput.serviceId` accepts for this provider. Not
   *  always the provider's most obvious "service" id — Square's booking API
   *  takes the item *variation* id, so that adapter flattens each catalog item
   *  into one Service per variation. */
  id: string;
  name: string;
  description?: string;
  durationMinutes?: number;
  price?: Money;
  categoryId?: string;
  categoryName?: string;
  /** False only when the provider explicitly says so; true when it has no
   *  active/inactive concept (everything it returns is bookable). */
  active: boolean;
  raw: unknown;
}

export interface Staff {
  /** The id that `CreateBookingInput.staffId` accepts for this provider. */
  id: string;
  name: string;
  email?: string;
  phone?: string;
  active: boolean;
  raw: unknown;
}

export interface ListServicesQuery {
  /** Maximum entries to return. Forwarded to providers that support a page
   *  size; for the several that do not, the page is trimmed locally instead —
   *  but only when it is the LAST page, since trimming a page that carries a
   *  `nextPageToken` would hide the entries between the cut and the next page. */
  limit?: number;
  /** Opaque, provider-defined. Pass the previous result's `nextPageToken`. */
  pageToken?: string;
}

export interface ListServicesResult {
  services: Service[];
  nextPageToken?: string;
}

export interface ListStaffQuery {
  /** Same semantics as `ListServicesQuery.limit`. */
  limit?: number;
  pageToken?: string;
}

export interface ListStaffResult {
  staff: Staff[];
  nextPageToken?: string;
}

export interface CreateServiceInput {
  name: string;
  description?: string;
  durationMinutes?: number;
  price?: Money;
  /** Escape hatch for provider-specific required fields. */
  providerOptions?: Record<string, unknown>;
}

/** Partial update. Omitted fields are left untouched — an adapter must never
 *  clear a field the caller did not mention. */
export interface UpdateServiceInput {
  name?: string;
  description?: string;
  durationMinutes?: number;
  price?: Money;
  providerOptions?: Record<string, unknown>;
}

export interface CreateStaffInput {
  name: string;
  email?: string;
  phone?: string;
  providerOptions?: Record<string, unknown>;
}

export interface UpdateStaffInput {
  name?: string;
  email?: string;
  phone?: string;
  providerOptions?: Record<string, unknown>;
}

/** One calendar in a connected account. */
export interface Calendar {
  /** Exactly what this adapter accepts to target the calendar — Google and
   *  Outlook `calendarId`, Apple `calendarUrl`. Same round-trip rule as
   *  `Service.id`: listing hands back the id that operations take. */
  id: string;
  name: string;
  /** IANA zone, when the provider reports one. */
  timezone?: string;
  /** True only when the provider marks it primary/default. CalDAV has no
   *  portable notion of one, so Apple calendars are never primary. */
  primary: boolean;
  /** True when these credentials cannot create or modify events in it. */
  readOnly: boolean;
  /** `#RRGGBB`, when the provider reports a color. */
  color?: string;
  raw: unknown;
}

export interface ListCalendarsQuery {
  /** Same semantics as `ListServicesQuery.limit`. */
  limit?: number;
  /** Opaque, provider-defined. Pass the previous result's `nextPageToken`. */
  pageToken?: string;
}

export interface ListCalendarsResult {
  calendars: Calendar[];
  nextPageToken?: string;
}

/** The result of a liveness probe. A dead connection is the expected answer to
 *  this question, so it is reported rather than thrown. */
export interface ConnectionStatus {
  ok: boolean;
  /** Set when `ok` is false. Deliberately a narrow literal union rather than
   *  `ErrorCode`: only these three mean "the credentials no longer work", and
   *  importing `ErrorCode` here would form a cycle (`errors.ts` already imports
   *  `ProviderId` from this module). */
  reason?: 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND';
  /** The provider's own message, when it gave one. */
  message?: string;
  /** Whatever identity the probe surfaced. All fields optional — providers
   *  differ widely in what a probe returns. */
  account?: { id?: string; name?: string; email?: string };
  raw: unknown;
}

/** Credentials are never persisted by this package. With the function form of
 *  `CredsInput`, no token is even retained on the client — it is fetched fresh
 *  per request. Each adapter narrows this to its own concrete credential type. */
export interface ProviderCredentials {
  [key: string]: unknown;
}

/** A credentials value, or a (possibly async) function returning one. The
 *  function form is resolved before every request, which is how token refresh
 *  is handled without the consumer racing token expiry. */
export type CredsInput<T> = T | (() => T | Promise<T>);

export interface ClientOptions {
  /** Inject a custom fetch (testing, proxies, non-global-fetch runtimes). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Override the provider base URL (sandbox / self-hosted / regional hosts). */
  baseUrl?: string;
  /** Injectable clock for deterministic tests (used for Retry-After math). */
  now?: () => Date;
}

export interface CustomerOps {
  /** Resolve a canonical customer to a provider-side customer id, creating one
   *  if needed. Only present when `capabilities.customers` is true. */
  findOrCreate(customer: Customer): Promise<string>;
}

/** The uniform surface every adapter exposes. `customers` is present only when
 *  `capabilities.customers` is true. */
export interface BookingClient {
  readonly id: ProviderId;
  readonly capabilities: Capabilities;
  createBooking(input: CreateBookingInput): Promise<Booking>;
  getBooking(id: string): Promise<Booking>;
  updateBooking(id: string, input: UpdateBookingInput): Promise<Booking>;
  cancelBooking(id: string, options?: CancelOptions): Promise<void>;
  listBookings(query: ListBookingsQuery): Promise<ListBookingsResult>;
  /** Throws `UnibookingError('UNSUPPORTED')` when `capabilities.availability` is false. */
  searchAvailability(query: AvailabilityQuery): Promise<AvailabilitySlot[]>;
  /** Present on every adapter. Never throws for a dead connection — that is the
   *  expected answer, returned as `{ ok: false, reason }`. Genuine faults
   *  (network, timeout, rate limit, 5xx) still throw, so a transient blip is
   *  never mistaken for a revoked integration. */
  checkConnection(): Promise<ConnectionStatus>;
  /** Present when `capabilities.serviceCatalog` is true. */
  listServices?(query?: ListServicesQuery): Promise<ListServicesResult>;
  /** Present when `capabilities.staffDirectory` is true. */
  listStaff?(query?: ListStaffQuery): Promise<ListStaffResult>;
  /** Present when `capabilities.calendarList` is true. */
  listCalendars?(query?: ListCalendarsQuery): Promise<ListCalendarsResult>;

  // --- Writes. Present when the matching `*Write` capability is true. --------
  //
  // There is deliberately no `deleteService` / `deleteStaff`. Deletion is not a
  // portable concept here: Square has no team-member delete at all (only
  // `status: INACTIVE`), and its catalog delete CASCADES — removing an item
  // removes every variation under it, and `Service.id` *is* a variation id. A
  // canonical `delete` would therefore mean something different, and something
  // irreversible, on each provider. `setServiceActive(id, false)` expresses the
  // thing callers actually want: make it unbookable, keep the history.

  createService?(input: CreateServiceInput): Promise<Service>;
  updateService?(id: string, input: UpdateServiceInput): Promise<Service>;
  /** Make a service bookable or unbookable without destroying it. */
  setServiceActive?(id: string, active: boolean): Promise<Service>;

  createStaff?(input: CreateStaffInput): Promise<Staff>;
  updateStaff?(id: string, input: UpdateStaffInput): Promise<Staff>;
  /** Activate or deactivate a staff member without destroying them. */
  setStaffActive?(id: string, active: boolean): Promise<Staff>;

  customers?: CustomerOps;
}

/** A callable adapter. Call it with credentials to get a `BookingClient`; it
 *  also carries `id`/`capabilities` so it can be dropped straight into a
 *  registry for dynamic dispatch. */
export interface AdapterFactory<TCreds extends ProviderCredentials = ProviderCredentials> {
  (creds: CredsInput<TCreds>, options?: ClientOptions): BookingClient;
  readonly id: ProviderId;
  readonly capabilities: Capabilities;
}
