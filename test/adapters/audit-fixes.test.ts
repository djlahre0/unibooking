import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { apple } from '../../src/adapters/apple';
import { acuity } from '../../src/adapters/acuity';
import { vagaro } from '../../src/adapters/vagaro';
import { setmore } from '../../src/adapters/setmore';
import { square } from '../../src/adapters/square';
import { mindbody } from '../../src/adapters/mindbody';
import { zenoti } from '../../src/adapters/zenoti';
import { google } from '../../src/adapters/google';
import { patchICS, parseICS } from '../../src/ical';
import { codeForStatus, isRetryable } from '../../src/errors';

/**
 * Regression tests for the bugs found in the July 2026 audit. Each asserts the
 * corrected behavior so the fix can't silently regress.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

let agent: MockAgent;
let previous: Dispatcher;
beforeEach(() => {
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  setGlobalDispatcher(previous);
  await agent.close();
});

// ---------------------------------------------------------------------------
// ical.patchICS — the primitive behind the Apple update fix
// ---------------------------------------------------------------------------
describe('ical.patchICS', () => {
  const RAW = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:STANDARD',
    'DTSTART:20251102T020000', // must NOT be touched (inside VTIMEZONE)
    'TZOFFSETFROM:-0400',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:evt-1',
    'SUMMARY:Weekly sync',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260720T220000Z',
    'DTEND:20260720T224500Z',
    'LOCATION:Room 5',
    'DESCRIPTION:Bring the report',
    'RRULE:FREQ=WEEKLY;COUNT=10',
    'ATTENDEE;CN=Bob:mailto:bob@example.com',
    'ATTENDEE;CN=Carol:mailto:carol@example.com',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('replaces only the requested VEVENT properties and preserves everything else', () => {
    const out = patchICS(RAW, {
      stamp: '2026-07-19T00:00:00Z',
      start: '2026-07-27T22:00:00Z',
      end: '2026-07-27T22:45:00Z',
      summary: 'Weekly sync (renamed)',
    });

    // Preserved:
    expect(out).toContain('LOCATION:Room 5');
    expect(out).toContain('DESCRIPTION:Bring the report');
    expect(out).toContain('RRULE:FREQ=WEEKLY;COUNT=10');
    expect(out).toContain('bob@example.com');
    expect(out).toContain('carol@example.com');
    expect(out).toContain('BEGIN:VALARM');
    // VTIMEZONE's inner DTSTART is untouched:
    expect(out).toContain('DTSTART:20251102T020000');

    // Replaced:
    expect(out).toContain('SUMMARY:Weekly sync (renamed)');
    expect(out).not.toContain('SUMMARY:Weekly sync\r');
    expect(out).toContain('DTSTART:20260727T220000Z');
    expect(out).toContain('DTEND:20260727T224500Z');
    expect(out).toContain('DTSTAMP:20260719T000000Z');
    expect(out).not.toContain('DTSTART:20260720T220000Z');

    // Still valid and re-parseable:
    const ev = parseICS(out)[0]!;
    expect(ev.uid).toBe('evt-1');
    expect(ev.start).toBe('2026-07-27T22:00:00Z');
  });

  it('inserts a set property that was absent, before END:VEVENT', () => {
    const noStatus = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:x',
      'DTSTART:20260720T220000Z',
      'DTEND:20260720T224500Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = patchICS(noStatus, { stamp: '2026-07-19T00:00:00Z', status: 'CONFIRMED' });
    expect(out).toContain('STATUS:CONFIRMED');
  });
});

// ---------------------------------------------------------------------------
// Apple: updateBooking preserves data; ids address the real resource
// ---------------------------------------------------------------------------
describe('AUDIT apple: update no longer destroys event data', () => {
  const ORIGIN = 'https://caldav.icloud.com';
  const CAL = 'https://caldav.icloud.com/123/calendars/home/';
  const RICH_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:evt-1',
    'SUMMARY:Weekly sync',
    'STATUS:CONFIRMED',
    'DTSTART:20260720T220000Z',
    'DTEND:20260720T224500Z',
    'LOCATION:Room 5',
    'DESCRIPTION:Bring the report',
    'RRULE:FREQ=WEEKLY;COUNT=10',
    'ATTENDEE;CN=Bob:mailto:bob@example.com',
    'ATTENDEE;CN=Carol:mailto:carol@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('preserves LOCATION/DESCRIPTION/RRULE/extra attendees when renaming', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'GET' })
      .reply(200, RICH_ICS, { headers: { 'content-type': 'text/calendar' } });
    let putBody = '';
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'PUT' })
      .reply(201, (opts) => {
        putBody = String(opts.body);
        return '';
      });

    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    await client.updateBooking('evt-1', { title: 'Renamed', range: { start: '2026-07-27T22:00:00Z', end: '2026-07-27T22:45:00Z' } });

    expect(putBody).toContain('LOCATION:Room 5');
    expect(putBody).toContain('DESCRIPTION:Bring the report');
    expect(putBody).toContain('RRULE:FREQ=WEEKLY;COUNT=10');
    expect(putBody).toContain('bob@example.com');
    expect(putBody).toContain('carol@example.com');
    expect(putBody).toContain('SUMMARY:Renamed');
    expect(putBody).toContain('DTSTART:20260727T220000Z');
  });

  it('a status with no iCal form (no_show) leaves the existing STATUS untouched', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'GET' })
      .reply(200, RICH_ICS, { headers: { 'content-type': 'text/calendar' } });
    let putBody = '';
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'PUT' })
      .reply(201, (opts) => {
        putBody = String(opts.body);
        return '';
      });
    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    await client.updateBooking('evt-1', { status: 'no_show' });
    expect(putBody).toContain('STATUS:CONFIRMED'); // not erased
  });

  it('listBookings ids the booking by the DAV href (not the UID) so it re-fetches', async () => {
    // Server stores the event under a name that is NOT its UID.
    const ICS = RICH_ICS.replace('UID:evt-1', 'UID:UPSTREAM-UID-999');
    const MULTISTATUS =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      `<D:response><D:href>/123/calendars/home/server-name-abc.ics</D:href>` +
      `<D:propstat><D:prop><C:calendar-data>${ICS}</C:calendar-data></D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home'), method: 'REPORT' })
      .reply(207, MULTISTATUS, { headers: { 'content-type': 'application/xml' } });

    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    const { bookings } = await client.listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
    });
    expect(bookings[0]!.id).toBe('server-name-abc');

    // …and that id addresses the real resource on a follow-up get.
    let hit = false;
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/server-name-abc.ics'), method: 'GET' })
      .reply(200, () => {
        hit = true;
        return ICS;
      }, { headers: { 'content-type': 'text/calendar' } });
    await client.getBooking(bookings[0]!.id);
    expect(hit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acuity: no more zero-length ranges/slots
// ---------------------------------------------------------------------------
describe('AUDIT acuity: rejects zero-length ranges/slots', () => {
  it('getBooking on a duration-less appointment throws UPSTREAM (not end===start)', async () => {
    agent
      .get('https://acuityscheduling.com')
      .intercept({ path: (p) => p.startsWith('/api/v1/appointments'), method: 'GET' })
      .reply(200, JSON.stringify({ id: 7, datetime: '2026-07-20T15:00:00-0700', type: 'Consult' }), {
        headers: JSON_HEADERS,
      });
    const err = await acuity({ userId: 'u', apiKey: 'k' }).getBooking('7').catch((e) => e);
    expect(err.code).toBe('UPSTREAM');
  });

  it('searchAvailability without durationMinutes throws INVALID_INPUT', async () => {
    const err = await acuity({ userId: 'u', apiKey: 'k' })
      .searchAvailability({
        range: { start: '2026-07-20T00:00:00-07:00', end: '2026-07-21T00:00:00-07:00' },
        serviceId: '12',
      })
      .catch((e) => e);
    expect(err.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Vagaro: unsizable availability slots are skipped, never zero-length
// ---------------------------------------------------------------------------
describe('AUDIT vagaro: skips unsizable slots', () => {
  it('drops a slot whose items[] carries no duration instead of emitting end===start', async () => {
    agent
      .get('https://api.vagaro.com')
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments/availability'), method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          data: [{ appointmentDate: '2026-07-20', items: [{ serviceProviderId: 'sp1' }], timeSlot: ['09:00'] }],
        }),
        { headers: JSON_HEADERS },
      );
    const slots = await vagaro({ region: 'usa03', businessId: 'biz1', accessToken: 't' }).searchAvailability({
      range: { start: '2026-07-20T22:00:00Z', end: '2026-07-20T23:00:00Z' },
      serviceId: 'svc1',
    });
    expect(slots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Setmore: appointments carry no status field at all
// ---------------------------------------------------------------------------
// The former "unrecognized status maps to unknown" case is obsolete: the
// Booking API returns no status/cancelled/no-show field on any documented
// appointment shape, so there is nothing to map. Every appointment Setmore
// hands back is implicitly active.
describe('AUDIT setmore: no status field is returned', () => {
  it('reports confirmed and ignores any stray status-like field', async () => {
    agent
      .get('https://developer.setmore.com')
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/appointments'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          response: true,
          data: {
            appointments: [
              {
                key: 'A1',
                start_time: '2026-07-20T09:00Z',
                end_time: '2026-07-20T09:30Z',
                label: 'x',
                status: 'SOME_NEW_STATE',
              },
            ],
          },
        }),
        { headers: JSON_HEADERS },
      );
    const page = await setmore({ accessToken: 't' }).listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
    });
    expect(page.bookings[0]!.status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// Square: listBookings forwards the customer_id filter
// ---------------------------------------------------------------------------
describe('AUDIT square: listBookings forwards customerId', () => {
  it('sends customer_id when the query carries customerId', async () => {
    let customerId: string | null = null;
    agent
      .get('https://connect.squareup.com')
      .intercept({ path: (p) => p.startsWith('/v2/bookings'), method: 'GET' })
      .reply(200, (opts) => {
        customerId = new URL('http://x' + opts.path).searchParams.get('customer_id');
        return JSON.stringify({ bookings: [] });
      }, { headers: JSON_HEADERS });
    await square({ accessToken: 't', locationId: 'L' }).listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      customerId: 'CUST1',
    });
    expect(customerId).toBe('CUST1');
  });
});

// ---------------------------------------------------------------------------
// Calendar-integration audit (2026-07-19)
// ---------------------------------------------------------------------------

// A 412 Precondition Failed is how CalDAV signals an If-Match (lost-update) or
// If-None-Match:* (create collision) failure. It must map to CONFLICT — a
// NON-retryable code — so withRetry can't silently re-run the write and clobber
// the concurrent edit the ETag guard was protecting against.
describe('AUDIT calendar: 412 Precondition Failed is a non-retryable CONFLICT', () => {
  it('codeForStatus(412) is CONFLICT and therefore not retryable', () => {
    expect(codeForStatus(412)).toBe('CONFLICT');
    expect(isRetryable(codeForStatus(412))).toBe(false);
  });

  it('apple updateBooking surfaces a concurrent-edit 412 as CONFLICT (was UPSTREAM)', async () => {
    const ORIGIN = 'https://caldav.icloud.com';
    const CAL = 'https://caldav.icloud.com/123/calendars/home/';
    const ICS = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:evt-1',
      'DTSTART:20260720T220000Z',
      'DTEND:20260720T224500Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'GET' })
      .reply(200, ICS, { headers: { 'content-type': 'text/calendar', etag: '"v1"' } });
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'PUT' })
      .reply(412, ''); // If-Match failed: someone else edited it first

    const err = await apple({ username: 'u', appPassword: 'p', calendarUrl: CAL })
      .updateBooking('evt-1', { title: 'Renamed' })
      .catch((e) => e);
    expect(err.code).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Google: updateBooking maps a canonical status onto the event status
// (previously only 'cancelled' was honored; 'pending'/'confirmed' were dropped)
// ---------------------------------------------------------------------------
describe('AUDIT google: updateBooking maps canonical status onto event status', () => {
  async function patchBodyFor(status: 'pending' | 'confirmed'): Promise<any> {
    let body: any;
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/calendars/primary/events'), method: 'PATCH' })
      .reply(200, (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({
          id: 'ev1',
          summary: 'x',
          start: { dateTime: '2026-07-20T15:00:00-07:00' },
          end: { dateTime: '2026-07-20T15:45:00-07:00' },
          status: 'confirmed',
        });
      }, { headers: JSON_HEADERS });
    await google({ accessToken: 't', calendarId: 'primary' }).updateBooking('ev1', { status });
    return body;
  }

  it('sends status:tentative for a pending update', async () => {
    expect((await patchBodyFor('pending')).status).toBe('tentative');
  });

  it('sends status:confirmed for a confirmed update', async () => {
    expect((await patchBodyFor('confirmed')).status).toBe('confirmed');
  });
});

describe('AUDIT google: notify maps to the sendUpdates query on create', () => {
  it('sends sendUpdates=all when notify is true, and omits it otherwise', async () => {
    const paths: string[] = [];
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/calendars/primary/events'), method: 'POST' })
      .reply(200, (opts) => {
        paths.push(opts.path);
        return JSON.stringify({
          id: 'ev1',
          summary: 'x',
          start: { dateTime: '2026-07-20T15:00:00-07:00' },
          end: { dateTime: '2026-07-20T15:45:00-07:00' },
          status: 'confirmed',
        });
      }, { headers: JSON_HEADERS })
      .times(2);
    const client = google({ accessToken: 't', calendarId: 'primary' });
    const range = { start: '2026-07-20T15:00:00-07:00', end: '2026-07-20T15:45:00-07:00' };
    await client.createBooking({ title: 'x', range, notify: true });
    await client.createBooking({ title: 'x', range });
    expect(paths[0]).toContain('sendUpdates=all');
    expect(paths[1]).not.toContain('sendUpdates');
  });
});

// ---------------------------------------------------------------------------
// Mindbody: IANA timezone is DST-correct (unlike a fixed offset)
// ---------------------------------------------------------------------------
describe('AUDIT mindbody: IANA timezone applies DST', () => {
  it('interprets a July site-local time as PDT (-07:00) when given the IANA zone', async () => {
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({ path: (p) => p.startsWith('/public/v6/appointment/staffappointments'), method: 'GET' })
      .reply(200, JSON.stringify({
        Appointments: [{
          Id: 1, StartDateTime: '2026-07-20T15:00:00', EndDateTime: '2026-07-20T15:45:00', Status: 'Booked',
        }],
      }), { headers: JSON_HEADERS });
    const client = mindbody({ apiKey: 'k', siteId: '-99', accessToken: 't', timezone: 'America/Los_Angeles' });
    const b = await client.getBooking('1');
    // 15:00 PDT (July, -07:00) === 22:00Z. A fixed -08:00 offset would wrongly give 23:00Z.
    expect(Date.parse(b.range.start)).toBe(Date.parse('2026-07-20T22:00:00Z'));
  });
});

// ---------------------------------------------------------------------------
// Docs-verification round (July 2026): bugs found by diffing against live specs
// ---------------------------------------------------------------------------
describe("AUDIT mindbody: cancel is supported via updateappointment", () => {
  it("POSTs Execute: cancel instead of throwing UNSUPPORTED", async () => {
    let body: any;
    agent
      .get("https://api.mindbodyonline.com")
      .intercept({ path: (p) => p.includes("/appointment/updateappointment"), method: "POST" })
      .reply(200, (opts: any) => { body = JSON.parse(String(opts.body)); return JSON.stringify({}); },
        { headers: JSON_HEADERS });
    await mindbody({ apiKey: "k", siteId: "1", accessToken: "t" })
      .cancelBooking("12345", { notify: true });
    expect(body.AppointmentId).toBe(12345);
    expect(body.Execute).toBe("cancel");
    expect(body.SendEmail).toBe(true);
  });
});

describe("AUDIT mindbody: create sends EndDateTime", () => {
  it("does not let the staff default duration silently override the range", async () => {
    let body: any;
    agent
      .get("https://api.mindbodyonline.com")
      .intercept({ path: (p) => p.includes("/appointment/addappointment"), method: "POST" })
      .reply(200, (opts: any) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ Appointment: { Id: 1, StartDateTime: "2026-07-20T09:00:00",
          EndDateTime: "2026-07-20T10:30:00", Status: "Booked" } });
      }, { headers: JSON_HEADERS });
    await mindbody({ apiKey: "k", siteId: "1", accessToken: "t", locationId: "1" }).createBooking({
      title: "x",
      range: { start: "2026-07-20T09:00:00Z", end: "2026-07-20T10:30:00Z" },
      customer: { id: "c1" }, staffId: "s1", serviceId: "svc1",
    });
    expect(body.StartDateTime).toBe("2026-07-20T09:00:00");
    expect(body.EndDateTime).toBe("2026-07-20T10:30:00");
  });
});

describe("AUDIT zenoti: service is nested under item.id", () => {
  it("sends item: { id, item_type }, not a flat service_id", async () => {
    let body: any;
    agent
      .get("https://api.zenoti.com")
      .intercept({ path: (p) => p.startsWith("/v1/bookings"), method: "POST" })
      .reply(200, (opts: any) => { body = JSON.parse(String(opts.body)); return JSON.stringify({ id: "bk1" }); },
        { headers: JSON_HEADERS });
    await zenoti({ apiKey: "k", centerId: "ctr1" }).searchAvailability({
      range: { start: "2026-07-20T09:00:00Z", end: "2026-07-20T17:00:00Z" },
      serviceId: "svc1",
      providerOptions: { guestId: "g1" },
      durationMinutes: 30,
    }).catch(() => undefined);
    expect(body.guests[0].items[0].item).toEqual({ id: "svc1", item_type: 0 });
    expect(body.guests[0].items[0].service_id).toBeUndefined();
  });
});
