'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Calendar } from 'unibooking';
import { callListCalendars, providerCapabilities, type Connection } from '../../lib/call';
import { browserZone } from '../../lib/datetime';

export type CalendarZone = {
  /** IANA zone the date/time pickers are read in. */
  zone: string;
  /** Where `zone` came from: the targeted calendar, or this browser as the
   *  fallback when the provider has no calendar list or reports no zone. */
  from: 'calendar' | 'browser';
  /** Name of the calendar the zone was read from, when `from` is 'calendar'. */
  calendarName?: string;
};

/**
 * The calendar these credentials target, or undefined when it can't be told.
 *
 * - Signed in via My Calendar: the session always books into the account's
 *   primary calendar (the explore route passes no calendar id), so a
 *   `calendarId` left over in the pasted fields must not be honoured.
 * - Otherwise an explicit `calendarId` (Google, Outlook) or `calendarUrl`
 *   (Apple) wins. One that isn't in the list gives undefined rather than the
 *   primary: naming the primary calendar's zone for a booking that goes to a
 *   different calendar would be wrong in exactly the way this guards against.
 * - No explicit id (or Google's `'primary'` alias): the primary calendar.
 */
export function targetCalendar(calendars: Calendar[], conn: Connection): Calendar | undefined {
  const wanted = conn.signedIn ? '' : conn.creds.calendarId || conn.creds.calendarUrl;
  if (wanted && wanted !== 'primary') return calendars.find((c) => c.id === wanted);
  return calendars.find((c) => c.primary) ?? (calendars.length === 1 ? calendars[0] : undefined);
}

const never = () => () => {};

/**
 * The zone a picked wall-clock date and time should be anchored in, so
 * "10:00" means 10:00 on the calendar the booking lands in rather than in
 * whatever zone the visitor's laptop is set to.
 *
 * `null` until known: the browser zone cannot be read during the server
 * render, and the calendar lookup is a network call.
 */
export function useCalendarZone(providerId: string, conn: Connection): CalendarZone | null {
  // False during the server render and hydration, true after: the browser
  // zone must never reach the server HTML.
  const mounted = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  const canList = !!providerId && !!providerCapabilities(providerId)?.calendarList;
  // `conn` is rebuilt on every page render; key the lookup on its contents.
  const key = `${providerId}|${JSON.stringify(conn)}`;
  const [lookup, setLookup] = useState<{ key: string; zone: CalendarZone } | null>(null);

  useEffect(() => {
    if (!canList) return;
    let live = true;
    const current = JSON.parse(key.slice(key.indexOf('|') + 1)) as Connection;
    const settle = (zone: CalendarZone) => {
      if (live) setLookup({ key, zone });
    };
    const fallback = (): CalendarZone => ({ zone: browserZone(), from: 'browser' });
    callListCalendars(providerId, current)
      .then((res) => {
        const calendars = res.ok ? ((res.data as { calendars?: Calendar[] })?.calendars ?? []) : [];
        const cal = targetCalendar(calendars, current);
        settle(
          cal?.timezone
            ? { zone: cal.timezone, from: 'calendar', calendarName: cal.name }
            : fallback(),
        );
      })
      .catch(() => settle(fallback()));
    return () => {
      live = false;
    };
  }, [canList, providerId, key]);

  if (!mounted) return null;
  if (!canList) return { zone: browserZone(), from: 'browser' };
  // A stale lookup for another provider or credentials never shows through.
  return lookup?.key === key ? lookup.zone : null;
}
