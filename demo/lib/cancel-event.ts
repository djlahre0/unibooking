import { UnibookingError, type Booking, type BookingClient } from 'unibooking';

/**
 * "Cancel" vs "Delete" for calendar events.
 *
 * On Google, Outlook and Apple the library's `cancelBooking()` removes the
 * event outright: calendars have no separate cancelled-booking record. The
 * explorer offers that as **Delete**, and adds **Cancel**: the event stays on
 * the calendar, visibly marked cancelled, and stops blocking the time.
 *
 * Built from `getBooking` + `updateBooking` only, per provider:
 * - Google: `status: 'cancelled'` would delete the event, so the title is
 *   marked and `transparency: 'transparent'` frees the slot. Guests are
 *   notified of the change.
 * - Outlook: PATCH cannot set `isCancelled`, so the title is marked and
 *   `showAs: 'free'` frees the slot.
 * - Apple: iCalendar has a real kept-but-cancelled state, `STATUS:CANCELLED`,
 *   which the canonical `status: 'cancelled'` writes. The title is marked too,
 *   since not every client renders that status.
 */

/** Providers whose bookings are calendar events, where Cancel ≠ Delete. */
export const CALENDAR_PROVIDERS: ReadonlySet<string> = new Set(['google', 'outlook', 'apple']);

export const CANCELLED_PREFIX = 'Cancelled: ';

/** True when the event has already been marked cancelled by `markCancelled`
 *  (or is cancelled at the provider). */
export function isMarkedCancelled(b: Pick<Booking, 'title' | 'status'>): boolean {
  return b.status === 'cancelled' || (b.title ?? '').startsWith(CANCELLED_PREFIX);
}

/** Marking free: the one field that differs per provider. */
const FREE_UP: Record<string, Record<string, unknown>> = {
  google: { transparency: 'transparent' },
  outlook: { showAs: 'free' },
};

export async function markCancelled(
  client: BookingClient,
  id: string,
  reason?: string,
): Promise<Booking> {
  if (!CALENDAR_PROVIDERS.has(client.id)) {
    throw new UnibookingError({
      provider: client.id,
      code: 'UNSUPPORTED',
      message: 'Cancel-and-keep applies to calendar events only; use cancelBooking().',
    });
  }
  const current = await client.getBooking(id);
  const title = current.title.startsWith(CANCELLED_PREFIX)
    ? current.title
    : `${CANCELLED_PREFIX}${current.title}`;
  const note = reason?.trim();
  return client.updateBooking(id, {
    title,
    notify: true,
    ...(note
      ? {
          description: current.description
            ? `${current.description}\n\nCancelled: ${note}`
            : `Cancelled: ${note}`,
        }
      : {}),
    ...(client.id === 'apple' ? { status: 'cancelled' as const } : {}),
    ...(FREE_UP[client.id] ? { providerOptions: FREE_UP[client.id] } : {}),
  });
}

/* ── Status: confirmed, tentative, cancelled, and back again ────────────── */

/** The three statuses a calendar event can be given here. `pending` is the
 *  library's name for tentative. */
export type EventStatus = 'confirmed' | 'pending' | 'cancelled';

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Tentative',
  cancelled: 'Cancelled',
};

/** The status to show for an event: a kept-but-cancelled marker wins, since on
 *  Google and Outlook the provider itself still reports the event as live. */
export function eventStatus(b: Pick<Booking, 'title' | 'status'>): EventStatus {
  if (isMarkedCancelled(b)) return 'cancelled';
  return b.status === 'pending' ? 'pending' : 'confirmed';
}

/** Undoing "free up the slot": the event blocks its time again. Outlook needs
 *  nothing here -- the library derives `showAs` from the status it is given. */
const BLOCK_AGAIN: Record<string, Record<string, unknown>> = {
  google: { transparency: 'opaque' },
};

/**
 * Give a calendar event a status. Cancelled keeps the event (see
 * markCancelled); confirmed or tentative sets that status and, on an event
 * that was cancelled here, restores it: the "Cancelled: " title prefix comes
 * off and the time is blocked again.
 */
export async function setEventStatus(
  client: BookingClient,
  id: string,
  status: EventStatus,
  reason?: string,
): Promise<Booking> {
  if (status === 'cancelled') return markCancelled(client, id, reason);
  if (!CALENDAR_PROVIDERS.has(client.id)) {
    throw new UnibookingError({
      provider: client.id,
      code: 'UNSUPPORTED',
      message: 'setEventStatus applies to calendar events only; use updateBooking({ status }).',
    });
  }
  const current = await client.getBooking(id);
  const title = current.title.startsWith(CANCELLED_PREFIX)
    ? current.title.slice(CANCELLED_PREFIX.length)
    : current.title;
  return client.updateBooking(id, {
    status,
    notify: true,
    ...(title !== current.title ? { title } : {}),
    ...(BLOCK_AGAIN[client.id] ? { providerOptions: BLOCK_AGAIN[client.id] } : {}),
  });
}
