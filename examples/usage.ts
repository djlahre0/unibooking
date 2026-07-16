/**
 * Idiomatic consumer usage — a complete booking lifecycle (availability →
 * customer → create → read → reschedule → list → cancel) plus resilience,
 * dynamic dispatch, and webhook verification.
 *
 * This file is type-checked against the source; run it with real credentials via
 * your own runner (e.g. `tsx examples/usage.ts`). The mocked, assertion-backed
 * version of this exact walkthrough lives in test/quickstart.test.ts.
 *
 * Square is used here because it supports every capability, but every adapter
 * exposes the identical `BookingClient` interface — swap the import and the
 * credentials and the rest is unchanged.
 */
import { collectAll, createRegistry, isUnibookingError, listAll, withRetry } from 'unibooking';
import { google } from 'unibooking/adapters/google';
import { square } from 'unibooking/adapters/square';
import { verifySquareSignature } from 'unibooking/webhooks/square';

async function main() {
  // Credentials can be a value OR an async function called fresh per request (so
  // token refresh is handled and no token is retained). `options` is optional.
  const client = square(
    () => ({ accessToken: process.env.SQUARE_TOKEN!, locationId: process.env.SQUARE_LOCATION! }),
    { timeoutMs: 10_000 },
  );

  // `capabilities` tells you up front what a provider can do — typed, not stringly.
  console.log('capabilities:', client.capabilities);

  const serviceId = process.env.SQUARE_SERVICE_ID!;

  // 1. Resolve (or create) a provider-side customer. Only present when
  //    `capabilities.customers` is true.
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
  if (!slot) throw new Error('no availability in range');

  // 3. Create a booking. An `idempotencyKey` makes a network retry safe.
  const booking = await client.createBooking({
    title: 'Haircut — Jane',
    range: { start: slot.start, end: slot.end },
    serviceId,
    ...(slot.staffId ? { staffId: slot.staffId } : {}),
    customer: { id: customerId },
    idempotencyKey: crypto.randomUUID(),
  });
  console.log('created:', booking.id, booking.range);

  // 4. Read it back by id.
  const fetched = await client.getBooking(booking.id);
  console.log('status:', fetched.status);

  // 5. Reschedule — returns the updated booking.
  const moved = await client.updateBooking(booking.id, {
    range: { start: '2026-07-20T16:00:00-07:00', end: '2026-07-20T16:45:00-07:00' },
  });

  // 6. List one page (with an opaque nextPageToken) …
  const page = await client.listBookings({
    range: { start: '2026-07-20T00:00:00-07:00', end: '2026-07-27T00:00:00-07:00' },
  });
  console.log('page:', page.bookings.length, page.nextPageToken);

  // … or let listAll / collectAll auto-paginate across every page.
  for await (const b of listAll(client, { range: moved.range })) {
    console.log('booking', b.id, b.status);
  }
  const everything = await collectAll(client, { range: moved.range });
  console.log('total across pages:', everything.length);

  // 7. Cancel.
  await client.cancelBooking(booking.id, { reason: 'Client rescheduled', notify: true });

  // Resilience + typed errors: `withRetry` adds backoff that honors Retry-After;
  // every failure is a `UnibookingError` you branch on by `code`.
  const resilient = withRetry(client, { retries: 3 });
  try {
    await resilient.getBooking('does-not-exist');
  } catch (err) {
    if (isUnibookingError(err) && err.code === 'NOT_FOUND') {
      console.log('booking not found');
    } else {
      throw err;
    }
  }

  // Dynamic dispatch by provider id (e.g. one adapter per connected account).
  // Registration is explicit, so there are no import side effects.
  const registry = createRegistry([google, square]);
  console.log('registered providers:', registry.ids().join(', '));
  const dispatched = registry.get('square')({ accessToken: 't', locationId: 'L' });
  console.log('dispatched', dispatched.id);

  // Webhooks: you host the endpoint; unibooking verifies the signature. Square
  // signs `notificationUrl + rawBody` (HMAC-SHA256, base64). Pass the EXACT raw
  // body — never a re-serialized object.
  const valid = await verifySquareSignature({
    signatureKey: process.env.SQUARE_WEBHOOK_KEY ?? '',
    notificationUrl: process.env.SQUARE_WEBHOOK_URL ?? '',
    body: process.env.SQUARE_WEBHOOK_BODY ?? '',
    signature: process.env.SQUARE_WEBHOOK_SIGNATURE ?? '',
  });
  console.log('square webhook valid?', valid);
}

main().catch(console.error);
