# unibooking

A **stateless, unified CRUD interface** for booking platforms and calendar
providers — Google Calendar, Outlook/Microsoft 365, Microsoft Bookings, Square
Appointments, Acuity, Bookeo, Mindbody, Wix Bookings, Calendly, Setmore,
Boulevard, Phorest, Zenoti, Vagaro, and any Apple/CalDAV server — behind one
small, strongly-typed API.

- **Zero runtime dependencies.** Uses global `fetch`, `AbortController`, and Web
  Crypto. Runs on Node 18+, edge runtimes, Deno, and Bun.
- **Stateless & refresh-aware.** Credentials can be a value *or* an async
  function that's called fresh per request, so token refresh is handled and no
  token is retained.
- **One canonical shape + a `raw` escape hatch.** A lean `Booking` model that
  maps across every provider, plus `raw` so you never lose information.
- **Typed capabilities & normalized errors.** `client.capabilities` tells you up
  front what a provider can do; every failure is a `UnibookingError` with a
  discriminated `code`.
- **Tree-shakeable.** Import only the adapters you use.

```bash
npm install unibooking
```

## Quick start

Every adapter exposes the **same** methods. Here is a complete lifecycle —
availability → customer → create → read → reschedule → list → cancel — against
Square (which supports every capability). A runnable, assertion-backed version of
this exact walkthrough lives in
[test/quickstart.test.ts](./test/quickstart.test.ts).

```ts
import { square } from 'unibooking/adapters/square';
import { listAll, collectAll, withRetry, isUnibookingError } from 'unibooking';

// Credentials can be a value OR an async function that's called fresh per request
// (so token refresh is handled and no token is retained). `options` is optional.
const client = square(
  () => ({ accessToken: process.env.SQUARE_TOKEN!, locationId: process.env.SQUARE_LOCATION! }),
  { timeoutMs: 10_000 },
);

// `capabilities` tells you up front what a provider can do — typed, not stringly,
// so the compiler catches typos and unsupported calls are obvious.
console.log(client.capabilities);
// { availability: true, staff: true, services: true, webhooks: true,
//   idempotency: true, customers: true }

const serviceId = 'SERVICE_VARIATION_ID';

// 1. Resolve (or create) a provider-side customer. Only present when
//    `capabilities.customers` is true, so guard with `?.` or a capability check.
const customerId = await client.customers!.findOrCreate({
  name: 'Jane Doe',
  email: 'jane@example.com',
});

// 2. Find open slots for a service in a time window.
const slots = await client.searchAvailability({
  range: { start: '2026-07-20T00:00:00-07:00', end: '2026-07-21T00:00:00-07:00' },
  serviceId,
});
const slot = slots[0];

// 3. Create a booking. An `idempotencyKey` makes a network retry safe — the same
//    key can't create a duplicate booking.
const booking = await client.createBooking({
  title: 'Haircut — Jane',
  range: { start: slot.start, end: slot.end },
  serviceId,
  ...(slot.staffId ? { staffId: slot.staffId } : {}),
  customer: { id: customerId },
  idempotencyKey: crypto.randomUUID(),
});

// 4. Read it back by id.
const fetched = await client.getBooking(booking.id);

// 5. Reschedule (or change title/staff/service) — returns the updated booking.
const moved = await client.updateBooking(booking.id, {
  range: { start: '2026-07-20T16:00:00-07:00', end: '2026-07-20T16:45:00-07:00' },
});

// 6. List bookings in a window — one page (with an opaque `nextPageToken`) …
const page = await client.listBookings({
  range: { start: '2026-07-20T00:00:00-07:00', end: '2026-07-27T00:00:00-07:00' },
});
console.log(page.bookings.length, page.nextPageToken);

// … or let `listAll` / `collectAll` auto-paginate across every page for you.
for await (const b of listAll(client, { range: page.bookings[0].range })) {
  console.log(b.id, b.status, b.range.start);
}
const everything = await collectAll(client, { range: moved.range });

// 7. Cancel. `reason`/`notify` are honored by providers that support them.
await client.cancelBooking(booking.id, { reason: 'Client rescheduled', notify: true });

// Every failure is a typed `UnibookingError` — branch on `code`, never on a
// vendor-specific message. `withRetry` adds backoff that honors `Retry-After`.
const resilient = withRetry(client, { retries: 3 });
try {
  await resilient.getBooking('does-not-exist');
} catch (err) {
  if (isUnibookingError(err) && err.code === 'NOT_FOUND') {
    console.log('no such booking');
  } else {
    throw err;
  }
}
```

### Dynamic dispatch by provider id

```ts
import { createRegistry } from 'unibooking';
import { google } from 'unibooking/adapters/google';
import { square } from 'unibooking/adapters/square';

const registry = createRegistry([google, square]);
const client = registry.get(account.provider)(account.credentials);
```

Registration is explicit — you pass the adapters you imported — so there are no
import side effects and the package tree-shakes cleanly.

## The client API

Every adapter is a factory `AdapterFactory<Creds>` that returns a `BookingClient`:

```ts
interface BookingClient {
  readonly id: ProviderId;
  readonly capabilities: Capabilities;
  createBooking(input: CreateBookingInput): Promise<Booking>;
  getBooking(id: string): Promise<Booking>;
  updateBooking(id: string, input: UpdateBookingInput): Promise<Booking>;
  cancelBooking(id: string, options?: CancelOptions): Promise<void>;
  listBookings(query: ListBookingsQuery): Promise<ListBookingsResult>;
  searchAvailability(query: AvailabilityQuery): Promise<AvailabilitySlot[]>;
  customers?: { findOrCreate(customer: Customer): Promise<string> };
}
```

Times in the canonical `TimeRange` are **RFC3339 with an offset** (unambiguous
instants); `timezone` is an IANA name for display only. `end > start` is enforced.

### Errors

```ts
import { isUnibookingError } from 'unibooking';

try {
  await client.getBooking(id);
} catch (err) {
  if (isUnibookingError(err) && err.code === 'NOT_FOUND') { /* ... */ }
}
```

`code` is one of `AUTH`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT`,
`INVALID_INPUT`, `UNSUPPORTED`, `UPSTREAM`, `NETWORK`, `TIMEOUT`. Errors also
carry `httpStatus`, `providerCode`, `retryAfterMs` (on 429), and `requestId`
when available.

### Helpers

```ts
import { withRetry, listAll, collectAll } from 'unibooking';

const resilient = withRetry(client, { retries: 3 }); // backoff + Retry-After
for await (const b of listAll(client, { range })) { /* auto-paginate */ }
```

`withRetry` won't retry `createBooking` unless it carries an `idempotencyKey`
(or you opt in), so a retry can't silently double-book.

## Webhooks

Signature-verification helpers (Web Crypto, no deps):

```ts
import { verifySquareSignature } from 'unibooking/webhooks/square';
import { graphValidationToken, verifyGraphClientState } from 'unibooking/webhooks/outlook';
import { verifyAcuitySignature } from 'unibooking/webhooks/acuity';
import { verifyGoogleChannelToken } from 'unibooking/webhooks/google';
import { verifyVagaroToken } from 'unibooking/webhooks/vagaro';
import { verifyCalendlySignature } from 'unibooking/webhooks/calendly';
import { verifyMindbodySignature } from 'unibooking/webhooks/mindbody';
import { verifyWixWebhook } from 'unibooking/webhooks/wix';
import { verifyBoulevardSignature } from 'unibooking/webhooks/boulevard'; // best-effort
```

You host the HTTP endpoint; this package only verifies. See
[docs/providers](./docs/providers/) for the exact headers per provider.

## Providers & capabilities

| Provider | availability | staff | services | webhooks | idempotency | customers |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `google` | – | – | – | ✓ | – | – |
| `outlook` | – | – | – | ✓ | ✓ | – |
| `microsoft_bookings` | – | ✓ | ✓ | – | – | – |
| `square` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `acuity` | ✓ | ✓ | ✓ | ✓ | – | – |
| `bookeo` | ✓ | – | ✓ | – | – | – |
| `mindbody` | ✓ | ✓ | ✓ | ✓ | – | – |
| `apple` (CalDAV) | – | – | – | – | ✓ | – |
| `phorest` | ✓ | ✓ | ✓ | – | – | ✓ |
| `zenoti` | ✓ | ✓ | ✓ | – | – | ✓ |
| `vagaro` | ✓ | – | – | ✓ | – | – |
| `wix` | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| `calendly` | ✓ | – | ✓ | ✓ | – | – |
| `setmore` | ✓ | ✓ | ✓ | – | – | ✓ |
| `boulevard` | – | ✓ | ✓ | ✓ | – | ✓ |
| `mangomint` | – | – | – | – | – | – |

`vagaro` is read-only (writes throw `UNSUPPORTED`). `calendly` has no reschedule
endpoint, so `updateBooking` with a new time does cancel+rebook. `boulevard`
`searchAvailability` throws `UNSUPPORTED` (bookable-time queries live on its
separate Client cart API). `mangomint` is a registered stub whose methods throw
`UNSUPPORTED` pending a public API. See
[docs/comparison.md](./docs/comparison.md) for the per-provider status.

See the tiered access notes and per-provider setup in [docs/](./docs/).

## What this package does not do

- **OAuth app registration** — you create developer apps with each vendor and
  bring your own client credentials.
- **Token acquisition/refresh** — bring your own; pass a value or a refresh
  function as credentials.
- **Webhook hosting** — you run the HTTP endpoint; this ships verifiers only.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm run lint
npm test            # vitest — includes the shared adapter conformance suite
npm run build       # tsup: dual ESM/CJS + .d.ts
```

Every adapter runs the shared conformance suite in
[test/conformance.ts](./test/conformance.ts), which asserts the canonical
contract (time invariants, status enum, error-code mapping, capability↔method
consistency) against mocked HTTP.

## License

MIT
