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
  | 'booker' // Mindbody Booker (booker.com) -- distinct from Bookeo
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
  /** `customers.list()` / `customers.get()` are available: the provider's
   *  existing client records can be read, e.g. to import and link them. */
  customerDirectory: boolean;
  /** `customers.create()` / `customers.update()` are available. */
  customerWrite: boolean;
  /** `customers.delete()` is available. */
  customerDelete: boolean;
  /** `createCalendar()` / `updateCalendar()` / `deleteCalendar()` are
   *  available: calendars themselves can be made, renamed and removed, not just
   *  listed. Calendar providers only. */
  calendarWrite: boolean;
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
  /** `createStaff()` / `updateStaff()` are available. Deactivating and
   *  deleting are separate flags (`staffDeactivate`, `staffDelete`) because
   *  providers genuinely differ: Square can deactivate but never delete a team
   *  member, Microsoft Bookings can delete but has no inactive state. */
  staffDirectoryWrite: boolean;
  /** `setStaffActive()` is available: the provider has a real inactive state
   *  for staff that keeps them (and their history) without offering them. */
  staffDeactivate: boolean;
  /** `deleteStaff()` is available: the provider removes staff outright. */
  staffDelete: boolean;
  /** `deleteService()` is available: the provider removes a service outright.
   *  Where false, `setServiceActive(id, false)` (when `serviceCatalogWrite`)
   *  is the only way to retire one. */
  serviceDelete: boolean;
  /** `listCalendars()` is available: the account's calendars can be enumerated
   *  and one picked to target. Plain calendar providers only — booking
   *  platforms have one schedule per business, not a list of calendars. */
  calendarList: boolean;
  /** `listClasses()` / `getClass()` are available. False for every provider
   *  with no group-class concept — the plain calendars (Google, Outlook,
   *  Apple) have events, which carry no capacity or enrollment. */
  classCatalog: boolean;
  /** `enrollInClass()` is available. Distinct from `classCatalog` for the same
   *  reason `serviceCatalogWrite` is distinct from `serviceCatalog`: a provider
   *  can publish its schedule without letting third parties enroll into it. */
  classEnrollment: boolean;
  /** Services and staff carry each other's ids — `Service.staffIds` and/or
   *  `Staff.serviceIds` — so a caller can tell who performs what without
   *  guessing. Also enables the `staffId`/`serviceId` filters on the list
   *  queries. */
  staffServiceAssignment: boolean;
  /** `assignStaffToService()` / `unassignStaffFromService()` are available:
   *  who performs a service can be changed, not just read. Implies
   *  `staffServiceAssignment`. */
  staffServiceAssignmentWrite: boolean;
  /** `listCategories()` is available: the catalog's own service groupings. */
  serviceCategories: boolean;
  /** `getBusinessHours()` is available: the recurring weekly opening hours of
   *  the business or location. Distinct from availability, which answers "is
   *  this specific slot bookable" — opening hours are the weekly pattern. */
  businessHours: boolean;
  /** A full class can be joined via `enrollInClass({ allowWaitlist: true })`,
   *  yielding a booking with `status: 'waitlisted'`. When false, a full class
   *  always throws `CONFLICT`. */
  classWaitlist: boolean;
  /** `syncBookings()` is available: what changed since the last sync, from a
   *  sync token, instead of re-listing everything. */
  changeFeed: boolean;
  /** `watchBookings()` / `renewWatch()` / `stopWatch()` are available: the
   *  provider notifies a URL you host when bookings change. Distinct from
   *  `webhooks`, which says a signature verifier exists — a provider can sign
   *  webhooks you configure in its dashboard without offering an API to
   *  subscribe. */
  changeNotifications: boolean;
  /** `Booking.version` is reported, and `updateBooking` / `cancelBooking`
   *  honour `ifVersion`: the write fails with `CONFLICT` instead of
   *  overwriting a change made since the booking was read. */
  versionedWrites: boolean;
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

export interface CreateCalendarInput {
  name: string;
  /** IANA zone. Google stores it on the calendar; Outlook and CalDAV have no
   *  per-calendar zone field, so it is ignored there. */
  timezone?: string;
  description?: string;
  /** `#RRGGBB`. Google and Apple store it; Outlook only has a named palette,
   *  so pass `providerOptions.color` there instead. */
  color?: string;
  providerOptions?: Record<string, unknown>;
}

/** Partial update: omitted fields are left untouched. */
export interface UpdateCalendarInput {
  name?: string;
  timezone?: string;
  description?: string;
  color?: string;
  providerOptions?: Record<string, unknown>;
}

/**
 * A client record as the provider holds it — what `customers.list/get/create/
 * update` return. Distinct from `Customer`, which is the loose "who is this
 * booking for" input: here `id` is always present, and it is the stable
 * provider id to link a record on your side to.
 */
export interface CustomerRecord {
  id: string;
  /** Full display name. Providers that split it are joined "given family". */
  name?: string;
  email?: string;
  phone?: string;
  /** Free-text note on the client, where the provider has one. */
  note?: string;
  /** RFC3339, when the provider reports it. */
  createdAt?: string;
  updatedAt?: string;
  raw: unknown;
}

export interface ListCustomersQuery {
  limit?: number;
  pageToken?: string;
  /** Exact match, case-insensitive. Where the provider cannot search by it,
   *  the page is filtered after it is read (like `listStaff({ serviceId })`). */
  email?: string;
  /** Exact match on the number as stored. Same filtering rule as `email`. */
  phone?: string;
}

export interface ListCustomersResult {
  customers: CustomerRecord[];
  nextPageToken?: string;
}

/** At least one of `name`, `email`, `phone`. */
export interface CreateCustomerInput {
  name?: string;
  email?: string;
  phone?: string;
  note?: string;
  providerOptions?: Record<string, unknown>;
}

/** Partial update: omitted fields are left untouched. */
export interface UpdateCustomerInput {
  name?: string;
  email?: string;
  phone?: string;
  note?: string;
  providerOptions?: Record<string, unknown>;
}

export type BookingStatus =
  | 'confirmed'
  | 'pending'
  | 'cancelled'
  | 'declined'
  | 'no_show'
  | 'completed'
  /** Enrolled onto a class waitlist rather than into the class itself. Only
   *  produced by `enrollInClass({ allowWaitlist: true })` against a provider
   *  whose `capabilities.classWaitlist` is true. */
  | 'waitlisted'
  | 'unknown';

export interface Booking {
  id: string;
  provider: ProviderId;
  title: string;
  range: TimeRange;
  customer?: Customer;
  staffId?: string;
  serviceId?: string;
  /** Set when this booking is an enrollment in a group class — the
   *  `ClassSession.id` it was created against. Only `enrollInClass` sets it;
   *  ordinary appointments leave it unset. */
  classId?: string;
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
  /** Set on one occurrence of a recurring series: the id that addresses the
   *  whole series. `id` itself addresses only this occurrence — updating or
   *  cancelling by `id` changes this one; by `seriesId`, all of them. Calendar
   *  providers (google, outlook, apple) set it; booking platforms leave it
   *  unset. */
  seriesId?: string;
  /** Opaque version of the booking as read (the provider's ETag). Pass it
   *  back as `ifVersion` to write only if nothing changed since. Reported
   *  where `capabilities.versionedWrites` is true. */
  version?: string;
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
  /** A `Booking.version`: apply the update only if the booking still has it,
   *  else throw `CONFLICT`. Requires `capabilities.versionedWrites`; other
   *  providers throw `UNSUPPORTED` rather than write unguarded. */
  ifVersion?: string;
  providerOptions?: Record<string, unknown>;
}

export interface CancelOptions {
  reason?: string;
  /** Whether the provider should notify the customer. Provider default when omitted. */
  notify?: boolean;
  /** Same as `UpdateBookingInput.ifVersion`. */
  ifVersion?: string;
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

// --- Change sync and notifications -------------------------------------------

export interface SyncBookingsQuery {
  /** The `syncToken` of the previous completed round. Omit for the first,
   *  full sync — which returns every booking as an upsert. */
  syncToken?: string;
  /** Continue a round: the previous page's `nextPageToken`. Send the same
   *  `syncToken` and `range` as the round's first page. */
  pageToken?: string;
  /** Window of the first full sync. Google applies it to the full sync only
   *  (later rounds report changes anywhere); Outlook requires it and keeps it
   *  for every round; Apple syncs the whole collection and ignores it. */
  range?: TimeRange;
}

export type BookingChange =
  | { type: 'upsert'; booking: Booking }
  /** Gone: deleted, or cancelled where the provider drops cancelled events.
   *  `id` is what `Booking.id` was. */
  | { type: 'delete'; id: string };

export interface SyncBookingsResult {
  changes: BookingChange[];
  /** More changes in this round: call again with it. */
  nextPageToken?: string;
  /** Round complete: store it and pass it as `syncToken` next time. */
  syncToken?: string;
  /** The `syncToken` was refused as expired or invalid. Discard what you
   *  synced and start again with no `syncToken`. An expected answer, so it is
   *  returned rather than thrown. */
  fullSyncRequired?: boolean;
}

export interface WatchInput {
  /** HTTPS URL of your notification endpoint. */
  address: string;
  /** A secret the provider echoes on every notification (Google
   *  `X-Goog-Channel-Token`, Graph `clientState`); verify it with
   *  `unibooking/webhooks/<id>`. Graph caps it at 128 characters. */
  token: string;
  /** Requested lifetime. Providers cap it (Graph: just under 7 days for
   *  events) and may shorten it; read `Watch.expiresAt` for the real end.
   *  Default: 7 days, or the provider's cap if lower. */
  ttlSeconds?: number;
  /** Graph only: HTTPS URL for lifecycle notifications
   *  (`reauthorizationRequired`, `subscriptionRemoved`, `missed`). */
  lifecycleAddress?: string;
}

/** An active change subscription. Store it: renewing and stopping need it. */
export interface Watch {
  /** Google channel id / Graph subscription id. */
  id: string;
  provider: ProviderId;
  /** Google's `resourceId`, needed to stop the channel. */
  resourceId?: string;
  /** When notifications stop unless renewed. RFC3339. */
  expiresAt?: string;
  raw: unknown;
}

export interface AvailabilityQuery {
  range: TimeRange;
  serviceId?: string;
  staffId?: string;
  durationMinutes?: number;
  // --- Slot rules --------------------------------------------------------
  // Honored by the providers that derive slots from busy time themselves
  // (google, outlook). Booking platforms compute slots server-side from their
  // own configured rules, so they ignore these, like `description` on a
  // booking. `computeSlots` applies the same rules to data you combine yourself.
  /** Minutes between candidate starts (a 30-minute service on a 15-minute grid
   *  can start at :00, :15, :30, :45). Default: back-to-back slots of
   *  `durationMinutes`. */
  intervalMinutes?: number;
  /** Only offer slots inside these weekly hours — the staff member's schedule
   *  or the business's opening hours (`getBusinessHours()` returns this shape).
   *  Without it, any free time in `range` is offered, including the night. */
  workingHours?: WorkingHours;
  /** Free time required before each slot (travel, preparation). */
  bufferBeforeMinutes?: number;
  /** Free time required after each slot (cleanup). */
  bufferAfterMinutes?: number;
  /** Do not offer slots starting sooner than this many minutes from now. Slots
   *  that have already started are never offered. */
  minNoticeMinutes?: number;
  /** Escape hatch for provider-specific availability inputs (e.g. Zenoti's
   *  `guestId`, whose slots are booking-scoped). Same role as
   *  `CreateBookingInput.providerOptions`. */
  providerOptions?: Record<string, unknown>;
}

/** Recurring weekly hours, anchored in a zone — a staff schedule or opening
 *  hours. `BusinessHours` from `getBusinessHours()` fits whenever it carries a
 *  timezone. */
export interface WorkingHours {
  /** IANA zone the periods are wall-clock times in. */
  timezone: string;
  periods: HoursPeriod[];
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
  /** Staff who can perform this service, as `Staff.id` values. Present only
   *  where `capabilities.staffServiceAssignment` is true. An empty array means
   *  the provider said "nobody"; undefined means it did not say. */
  staffIds?: string[];
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
  /** Services this member can perform, as `Service.id` values. Present only
   *  where `capabilities.staffServiceAssignment` is true, and only on the
   *  providers that report it from the staff side — several model the link on
   *  the service instead, where it surfaces as `Service.staffIds`. */
  serviceIds?: string[];
  raw: unknown;
}

/** A grouping of services, as the provider's own catalog defines it. */
export interface ServiceCategory {
  /** Matches `Service.categoryId`. Providers with no category *id* (Acuity
   *  names them only) use the name here, so the two still join up. */
  id: string;
  name: string;
  provider: ProviderId;
  raw: unknown;
}

export interface ListCategoriesResult {
  categories: ServiceCategory[];
  nextPageToken?: string;
}

// --- Business hours --------------------------------------------------------
// When the business is open, as recurring weekly wall-clock windows. These are
// NOT instants: "09:00 on Monday" repeats every week and only becomes a moment
// once anchored in `timezone` on a specific date (see `zonedToInstant`).

export type Weekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

export interface HoursPeriod {
  dayOfWeek: Weekday;
  /** Local wall-clock `HH:MM` (24h) in `BusinessHours.timezone`. */
  start: string;
  /** Local wall-clock `HH:MM`. May be less than or equal to `start` for a
   *  window that runs past midnight — compare dates, not strings. */
  end: string;
}

export interface BusinessHours {
  provider: ProviderId;
  /** IANA zone the periods are expressed in, when the provider reports one.
   *  Without it the periods cannot be anchored to real instants, so treat them
   *  as display-only. */
  timezone?: string;
  /** Sorted Monday-first, then by start time. A day the business is closed
   *  simply has no period; several periods on one day mean a split shift. */
  periods: HoursPeriod[];
  raw: unknown;
}

// --- Group classes ---------------------------------------------------------
// Providers split a class in two: the *definition* ("Vinyasa Flow", 60 min) and
// the scheduled *occurrence* ("Tuesday 6pm, 12 of 20 taken"). `Service` already
// models the definition, so only the occurrence is new here.

export type ClassStatus = 'scheduled' | 'cancelled' | 'completed' | 'unknown';

/** One scheduled occurrence of a group class. */
export interface ClassSession {
  /** The id that `EnrollInClassInput.classId` accepts for this provider. */
  id: string;
  provider: ProviderId;
  /** The class definition this occurrence belongs to, where the provider
   *  exposes one as a catalog entry. Matches a `Service.id`. */
  serviceId?: string;
  title: string;
  description?: string;
  range: TimeRange;
  /** Instructor. Matches a `Staff.id`. */
  staffId?: string;
  location?: string;
  /** Total spots. Undefined when the provider does not cap the class or does
   *  not report the cap. */
  capacity?: number;
  /** Spots already taken. */
  booked?: number;
  /** `capacity - booked`, floored at 0. Undefined when either input is. */
  available?: number;
  /** Whether the class can still be enrolled into. Deliberately NOT derived
   *  from `available`: several providers report bookability without exposing
   *  either number, so arithmetic would be wrong exactly when it matters. */
  full: boolean;
  status: ClassStatus;
  /** Total waitlist spots, when the provider has a waitlist at all. */
  waitlistCapacity?: number;
  waitlistCount?: number;
  price?: Money;
  raw: unknown;
}

export interface ListClassesQuery {
  /** Return occurrences overlapping this window. Providers that require a
   *  window get a provider-specific default when this is omitted. */
  range?: TimeRange;
  /** Only classes taught by this instructor. */
  staffId?: string;
  /** Only occurrences of this class definition. */
  serviceId?: string;
  /** Maximum entries to return. Same terminal-page backstop as
   *  `listServices` — see `ListServicesQuery.limit`. */
  limit?: number;
  /** Opaque, provider-defined. Pass the previous result's `nextPageToken`. */
  pageToken?: string;
}

export interface ListClassesResult {
  classes: ClassSession[];
  nextPageToken?: string;
}

export interface EnrollInClassInput {
  /** A `ClassSession.id`. */
  classId: string;
  customer: Customer;
  /** When the class is full, join the waitlist instead of throwing. Requires
   *  `capabilities.classWaitlist`; without it a full class throws `CONFLICT`
   *  whatever this says. Defaults to false. */
  allowWaitlist?: boolean;
  /** Honored when `capabilities.idempotency` is true. */
  idempotencyKey?: string;
  notes?: string;
}

export interface ListServicesQuery {
  /** Only services this staff member can perform. Requires
   *  `capabilities.staffServiceAssignment`; ignored by providers without it,
   *  since they cannot answer the question. */
  staffId?: string;
  /** Only services in this category (a `ServiceCategory.id`). */
  categoryId?: string;
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
  /** Only staff who can perform this service (a `Service.id`). Requires
   *  `capabilities.staffServiceAssignment`; ignored by providers without it. */
  serviceId?: string;
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
  /** Activate (`true`) or deactivate (`false`) in the same call — the same
   *  effect as `setServiceActive`, applied after the other fields. Available
   *  wherever `updateService` is (`serviceCatalogWrite`). */
  active?: boolean;
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
  /** Activate or deactivate in the same call — the same effect as
   *  `setStaffActive`, applied after the other fields. Needs
   *  `capabilities.staffDeactivate`; elsewhere it throws `UNSUPPORTED` rather
   *  than being silently ignored (Microsoft Bookings has no inactive state). */
  active?: boolean;
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
  /** Page through the client records. Present when `customerDirectory`. */
  list?(query?: ListCustomersQuery): Promise<ListCustomersResult>;
  /** One client by id; throws `NOT_FOUND`. Present when `customerDirectory`
   *  (providers without a by-id endpoint page through `list`). */
  get?(id: string): Promise<CustomerRecord>;
  /** Always creates: use `findOrCreate` to reuse an existing match instead.
   *  Present when `customerWrite`. */
  create?(input: CreateCustomerInput): Promise<CustomerRecord>;
  /** Present when `customerWrite`. */
  update?(id: string, input: UpdateCustomerInput): Promise<CustomerRecord>;
  /** Present when `customerDelete`. */
  delete?(id: string): Promise<void>;
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
  /** One service by `Service.id`. Present when `capabilities.serviceCatalog`
   *  is true; throws `NOT_FOUND` for an unknown id. Providers without a
   *  by-id endpoint page through `listServices` to find it. */
  getService?(id: string): Promise<Service>;
  /** One staff member by `Staff.id`. Present when `capabilities.staffDirectory`
   *  is true; same fallback and `NOT_FOUND` rule as `getService`. */
  getStaff?(id: string): Promise<Staff>;
  /** Present when `capabilities.calendarList` is true. */
  listCalendars?(query?: ListCalendarsQuery): Promise<ListCalendarsResult>;
  /** One calendar by `Calendar.id`; throws `NOT_FOUND`. Present when
   *  `capabilities.calendarList` (a bounded walk of `listCalendars`). */
  getCalendar?(id: string): Promise<Calendar>;
  /** Present when `capabilities.calendarWrite`. */
  createCalendar?(input: CreateCalendarInput): Promise<Calendar>;
  /** Present when `capabilities.calendarWrite`. */
  updateCalendar?(id: string, input: UpdateCalendarInput): Promise<Calendar>;
  /** Removes the calendar AND every event in it. The account's primary /
   *  default calendar cannot be deleted (`INVALID_INPUT`). Present when
   *  `capabilities.calendarWrite`. */
  deleteCalendar?(id: string): Promise<void>;
  /** Present when `capabilities.serviceCategories` is true. */
  listCategories?(): Promise<ListCategoriesResult>;
  /** Present when `capabilities.businessHours` is true. */
  getBusinessHours?(): Promise<BusinessHours>;
  /** Present when `capabilities.classCatalog` is true. */
  listClasses?(query?: ListClassesQuery): Promise<ListClassesResult>;
  /** Present when `capabilities.classCatalog` is true. */
  getClass?(id: string): Promise<ClassSession>;
  /** What changed since the last sync. Present when `capabilities.changeFeed`
   *  is true. */
  syncBookings?(query?: SyncBookingsQuery): Promise<SyncBookingsResult>;
  /** Ask the provider to notify `input.address` when bookings change. Present
   *  when `capabilities.changeNotifications` is true. */
  watchBookings?(input: WatchInput): Promise<Watch>;
  /** Extend a watch before `expiresAt`. Returns the watch to store from now on
   *  — Google replaces the channel (new `id`), Graph extends the subscription.
   *  Pass the same `input` the watch was created with. */
  renewWatch?(watch: Watch, input: WatchInput): Promise<Watch>;
  /** Stop notifications. A watch that already ended is not an error. */
  stopWatch?(watch: Watch): Promise<void>;
  /** Enroll a customer into a group class. Present when
   *  `capabilities.classEnrollment` is true.
   *
   *  Returns an ordinary `Booking` carrying `classId`, so cancelling an
   *  enrollment is just `cancelBooking(booking.id)` and enrollments show up in
   *  `listBookings` alongside appointments — there is deliberately no parallel
   *  enrollment lifecycle to keep in sync.
   *
   *  Throws `CONFLICT` when the class is full and the waitlist is either not
   *  requested or not supported. */
  enrollInClass?(input: EnrollInClassInput): Promise<Booking>;

  // --- Writes. Present when the matching capability is true. ---------------
  //
  // Retiring and deleting are separate on purpose. `setServiceActive(id,
  // false)` / `setStaffActive(id, false)` make something unbookable and keep
  // its history; `deleteService` / `deleteStaff` remove it, and each has its
  // own flag because support genuinely differs (Square cannot delete a team
  // member at all; Microsoft Bookings has no inactive state). A delete removes
  // exactly the one service or staff member named, never its siblings: on
  // Square, where `Service.id` is a variation and deleting the parent item
  // cascades, only the variation is deleted unless it is the item's last one.

  createService?(input: CreateServiceInput): Promise<Service>;
  updateService?(id: string, input: UpdateServiceInput): Promise<Service>;
  /** Make a service bookable or unbookable without destroying it. */
  setServiceActive?(id: string, active: boolean): Promise<Service>;

  createStaff?(input: CreateStaffInput): Promise<Staff>;
  updateStaff?(id: string, input: UpdateStaffInput): Promise<Staff>;
  /** Activate or deactivate a staff member without destroying them. Present
   *  when `capabilities.staffDeactivate`. */
  setStaffActive?(id: string, active: boolean): Promise<Staff>;
  /** Remove a service outright. Present when `capabilities.serviceDelete`. */
  deleteService?(id: string): Promise<void>;
  /** Remove a staff member outright. Present when `capabilities.staffDelete`. */
  deleteStaff?(id: string): Promise<void>;
  /** Let `staffId` perform `serviceId`. Already assigned is not an error.
   *  Present when `capabilities.staffServiceAssignmentWrite`; returns the
   *  service with its updated `staffIds`. */
  assignStaffToService?(serviceId: string, staffId: string): Promise<Service>;
  /** Stop `staffId` performing `serviceId`. Not assigned is not an error.
   *  Present when `capabilities.staffServiceAssignmentWrite`. */
  unassignStaffFromService?(serviceId: string, staffId: string): Promise<Service>;

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
