import {
  listAll,
  UnibookingError,
  type BookingClient,
  type CreateBookingInput,
  type UpdateBookingInput,
} from 'unibooking';
import { google } from 'unibooking/adapters/google';
import { outlook } from 'unibooking/adapters/outlook';
import { apple } from 'unibooking/adapters/apple';
import { withAutoRefresh, type OAuthClient, type OAuthTokens } from 'unibooking/oauth';
import { assertSafeCalendarUrl } from '../validate-caldav';
import { markCancelled, setEventStatus, type EventStatus } from '../cancel-event';
import { customOAuthClient, oauthClient, redirectUri, type CalendarConfig } from './config';
import type { CalendarSession, StoredTokens } from './session';
import type { CalendarOp, EventInput } from './types';

/**
 * The server side of My Calendar: turn a session into a unibooking client and
 * run one operation on it: SERVER ONLY.
 *
 * Every provider call goes through the library's adapters, so the demo carries
 * no provider logic of its own. OAuth sessions are wrapped in
 * `withAutoRefresh`, which refreshes shortly before expiry and hands the new
 * tokens to `onRefresh` so the route can re-seal the cookie on the same response.
 */

/** A window is capped so one request can't fan out without bound. */
export const MAX_EVENTS = 250;
const MAX_CALENDAR_PAGES = 5;
const OPTIONS = { timeoutMs: 10_000 };

/** The refresh-token exchange failed. Distinct from an API failure because the
 *  route answers it differently: the grant is gone, so the session is cleared. */
export class RefreshFailed extends Error {
  constructor(readonly reason: unknown) {
    super('token refresh failed');
    this.name = 'RefreshFailed';
  }
}

/** What gets sealed: never the provider's raw token response (bulky, and it can
 *  carry an id_token the demo has no use for). */
export function storedTokens(t: OAuthTokens): StoredTokens {
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
  };
}

export function clientFor(
  session: CalendarSession,
  config: CalendarConfig,
  origin: string,
  calendarId: string | undefined,
  onRefresh: (tokens: StoredTokens) => void,
): BookingClient {
  if (session.provider === 'apple') {
    // A calendar id is a CalDAV URL the server will fetch with the user's
    // password attached, so it gets the same SSRF guard as the proxy route.
    const calendarUrl = calendarId ? assertSafeCalendarUrl(calendarId) : undefined;
    return apple({ ...session.apple, ...(calendarUrl ? { calendarUrl } : {}) }, OPTIONS);
  }

  // "Bring your own OAuth app" sessions carry their own client id/secret --
  // refresh must use the SAME app that issued the token, not the deployer's
  // env-configured one (which may not even exist).
  const base = session.custom
    ? customOAuthClient(session.provider, session.custom, redirectUri(origin, session.provider))
    : oauthClient(config, session.provider, redirectUri(origin, session.provider));
  const oauth: OAuthClient = {
    ...base,
    refresh: async (refreshToken) => {
      try {
        return await base.refresh(refreshToken);
      } catch (e) {
        throw new RefreshFailed(e);
      }
    },
  };
  const creds = withAutoRefresh({
    oauth,
    tokens: { ...session.tokens, raw: null },
    onRefresh: (t) => onRefresh(storedTokens(t)),
    toCreds: (t) => ({ accessToken: t.accessToken, ...(calendarId ? { calendarId } : {}) }),
  });
  return session.provider === 'google' ? google(creds, OPTIONS) : outlook(creds, OPTIONS);
}

type Args = Record<string, unknown>;

function invalid(client: BookingClient, message: string): UnibookingError {
  return new UnibookingError({ provider: client.id, code: 'INVALID_INPUT', message });
}

function text(client: BookingClient, args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw invalid(client, `${key} is required`);
  return v;
}

/** Every `EventInput` field that must be a string if it is present at all. */
const EVENT_STRINGS = ['title', 'start', 'end', 'timezone', 'description', 'location'] as const;

/**
 * The request body is JSON, so `event` can hold any type regardless of what
 * `EventInput` declares. Checked HERE, once, rather than field-by-field
 * downstream: `toUpdate` used to call `.trim()` on whatever arrived and turned
 * a malformed body into an internal TypeError, and a non-boolean `allDay` was
 * silently dropped by `details()`, so the update still went out to the
 * provider, minus the field the caller asked for. Both now fail closed.
 */
function eventOf(client: BookingClient, args: Args): EventInput {
  const e = args.event;
  if (e === null || typeof e !== 'object' || Array.isArray(e)) {
    throw invalid(client, 'event must be an object');
  }
  const raw = e as Record<string, unknown>;
  for (const key of EVENT_STRINGS) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      throw invalid(client, `event.${key} must be a string`);
    }
  }
  if (raw.allDay !== undefined && typeof raw.allDay !== 'boolean') {
    throw invalid(client, 'event.allDay must be true or false');
  }
  return raw as EventInput;
}

/** Optional string fields, passed through only when present. */
function details(e: EventInput): Pick<CreateBookingInput, 'description' | 'location' | 'allDay'> {
  return {
    ...(typeof e.description === 'string' ? { description: e.description } : {}),
    ...(typeof e.location === 'string' ? { location: e.location } : {}),
    ...(typeof e.allDay === 'boolean' ? { allDay: e.allDay } : {}),
  };
}

function rangeOf(e: EventInput) {
  return {
    start: e.start!,
    end: e.end!,
    ...(e.timezone ? { timezone: e.timezone } : {}),
  };
}

function toCreate(client: BookingClient, e: EventInput): CreateBookingInput {
  if (typeof e.title !== 'string' || e.title.trim() === '')
    throw invalid(client, 'title is required');
  if (!e.start || !e.end) throw invalid(client, 'start and end are required');
  return { title: e.title.trim(), range: rangeOf(e), ...details(e) };
}

function toUpdate(client: BookingClient, e: EventInput): UpdateBookingInput {
  if (!!e.start !== !!e.end) throw invalid(client, 'start and end must be changed together');
  if (e.title !== undefined && e.title.trim() === '')
    throw invalid(client, 'title cannot be empty');
  return {
    ...(e.title !== undefined ? { title: e.title.trim() } : {}),
    ...(e.start && e.end ? { range: rangeOf(e) } : {}),
    ...details(e),
  };
}

const STATUSES: readonly EventStatus[] = ['confirmed', 'pending', 'cancelled'];

/** Name / colour / zone from the request, validated. */
function calendarFields(client: BookingClient, args: Args, create: boolean) {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined;
  if (create && !name) throw invalid(client, 'a calendar needs a name');
  if (name !== undefined && !name) throw invalid(client, 'name cannot be empty');
  const color = typeof args.color === 'string' && args.color ? args.color : undefined;
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw invalid(client, 'color must be #RRGGBB');
  const timezone = typeof args.timezone === 'string' && args.timezone ? args.timezone : undefined;
  return {
    ...(name ? { name } : {}),
    ...(color ? { color } : {}),
    ...(timezone ? { timezone } : {}),
  };
}

export async function runCalendarOp(
  client: BookingClient,
  op: CalendarOp,
  args: Args,
): Promise<unknown> {
  switch (op) {
    case 'listCalendars': {
      if (!client.listCalendars) throw invalid(client, 'this provider has no calendar list');
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

    // The calendars themselves: the provider owns them; these ask it to make,
    // rename or remove one. `calendarWrite` adapters only.
    case 'createCalendar': {
      if (!client.createCalendar) throw invalid(client, 'this provider cannot create calendars');
      return client.createCalendar(calendarFields(client, args, true) as { name: string });
    }
    case 'updateCalendar': {
      if (!client.updateCalendar) throw invalid(client, 'this provider cannot rename calendars');
      return client.updateCalendar(text(client, args, 'calendarId'), calendarFields(client, args, false));
    }
    case 'deleteCalendar': {
      if (!client.deleteCalendar) throw invalid(client, 'this provider cannot delete calendars');
      const id = text(client, args, 'calendarId');
      await client.deleteCalendar(id);
      return { deleted: true, calendarId: id };
    }

    case 'listEvents': {
      const range = { start: text(client, args, 'start'), end: text(client, args, 'end') };
      const events = [];
      // Stop at one past the cap: that single extra event is what tells a
      // truncated window from one that happens to hold exactly MAX_EVENTS,
      // without paging through everything beyond it.
      for await (const b of listAll(client, { range, limit: MAX_EVENTS }, { maxPages: 10 })) {
        events.push(b);
        if (events.length > MAX_EVENTS) break;
      }
      return { events: events.slice(0, MAX_EVENTS), truncated: events.length > MAX_EVENTS };
    }

    case 'getEvent':
      return client.getBooking(text(client, args, 'id'));

    case 'createEvent':
      return client.createBooking(toCreate(client, eventOf(client, args)));

    case 'updateEvent': {
      const id = text(client, args, 'id');
      return client.updateBooking(id, toUpdate(client, eventOf(client, args)));
    }

    // Cancel keeps the event, marked cancelled; Delete (below) removes it.
    case 'cancelEvent':
      return markCancelled(client, text(client, args, 'id'));

    // Confirmed / tentative / cancelled, including undoing a cancel.
    case 'setEventStatus': {
      const status = text(client, args, 'status');
      if (!STATUSES.includes(status as EventStatus)) {
        throw invalid(client, `status must be one of ${STATUSES.join(', ')}`);
      }
      return setEventStatus(client, text(client, args, 'id'), status as EventStatus);
    }

    case 'deleteEvent': {
      const id = text(client, args, 'id');
      await client.cancelBooking(id);
      return { deleted: true, id };
    }
  }
}
