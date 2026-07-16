import type { Booking, BookingClient, ListBookingsQuery } from './types';

export interface ListAllOptions {
  /** Safety cap so a misbehaving provider token can't loop forever. Default 1000. */
  maxPages?: number;
}

/**
 * Auto-paginate `listBookings`, yielding every booking across pages. Stops on an
 * absent, repeated, or non-advancing page token (loop guard) and at `maxPages`.
 *
 *   for await (const b of listAll(client, { range })) { ... }
 */
export async function* listAll(
  client: BookingClient,
  query: ListBookingsQuery,
  options: ListAllOptions = {},
): AsyncGenerator<Booking, void, void> {
  const maxPages = options.maxPages ?? 1000;
  const { pageToken: _drop, ...base } = query;
  let token = query.pageToken;
  let pages = 0;
  // Track every token we've already requested so a provider that cycles
  // (p1 -> p2 -> p1 -> …), not just repeats immediately, is caught too.
  const seen = new Set<string>();
  if (token !== undefined) seen.add(token);

  for (;;) {
    const result = await client.listBookings(token !== undefined ? { ...base, pageToken: token } : base);
    for (const booking of result.bookings) yield booking;

    pages += 1;
    const next = result.nextPageToken;
    if (next === undefined || next === '' || pages >= maxPages || seen.has(next)) break;
    seen.add(next);
    token = next;
  }
}

/** Convenience: collect every booking into an array. */
export async function collectAll(
  client: BookingClient,
  query: ListBookingsQuery,
  options?: ListAllOptions,
): Promise<Booking[]> {
  const out: Booking[] = [];
  for await (const b of listAll(client, query, options)) out.push(b);
  return out;
}
