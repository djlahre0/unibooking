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
