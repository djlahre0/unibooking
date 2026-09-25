import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { apple } from '../../src/adapters/apple';

/**
 * One occurrence of a recurring CalDAV series is addressable on its own, the
 * way Google instance ids and Outlook occurrence ids already are. Before this,
 * every expanded instance carried the resource id — so editing "this Monday's"
 * instance rewrote the series master's DTSTART (moving the whole series and
 * erasing every earlier occurrence), and deleting it deleted the series.
 */

const ORIGIN = 'https://caldav.icloud.com';
const CAL = 'https://caldav.icloud.com/123/calendars/home/';
const TEXT = { 'content-type': 'text/calendar; charset=utf-8' };
const XML = { 'content-type': 'application/xml; charset=utf-8' };

/** A stored weekly series as iCloud serves it on GET. */
const SERIES = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//iCloud 2626B41//EN',
  'BEGIN:VEVENT',
  'UID:series-1',
  'DTSTAMP:20260701T000000Z',
  'SUMMARY:Weekly sync',
  'DTSTART:20260720T220000Z',
  'DTEND:20260720T223000Z',
  'RRULE:FREQ=WEEKLY',
  'SEQUENCE:0',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

/** The same kind of series anchored in a zone, as Apple Calendar writes it. */
const ZONED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 15.0//EN',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZNAME:EDT',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZNAME:EST',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:series-ny',
  'DTSTAMP:20260701T000000Z',
  'DTSTART;TZID=America/New_York:20260720T090000',
  'DTEND;TZID=America/New_York:20260720T093000',
  'RRULE:FREQ=WEEKLY',
  'SUMMARY:Standup',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function multistatus(href: string, ics: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<D:response><D:href>${href}</D:href>` +
    `<D:propstat><D:prop><D:getetag>"e1"</D:getetag><C:calendar-data>${ics}</C:calendar-data></D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
  );
}

/** The VEVENT blocks of a document, in order. */
function vevents(ics: string): string[] {
  return ics
    .split('BEGIN:VEVENT')
    .slice(1)
    .map((b) => b.split('END:VEVENT')[0]!);
}

describe('apple: recurring occurrences', () => {
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

  const client = () => apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });

  function serve(ics: string, etag = '"etag-1"') {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/series-'), method: 'GET' })
      .reply(200, ics, { headers: { ...TEXT, etag } });
  }

  function capturePut(): { body: () => string; headers: () => Record<string, string> } {
    let body = '';
    let headers: Record<string, string> = {};
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/series-'), method: 'PUT' })
      .reply(204, (opts) => {
        body = String(opts.body);
        headers = Object.fromEntries(
          Object.entries((opts.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            String(v),
          ]),
        );
        return '';
      });
    return { body: () => body, headers: () => headers };
  }

  it('gives each server-expanded instance its own id, and names the series', async () => {
    const EXPANDED = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-1',
      'RECURRENCE-ID:20260720T220000Z',
      'SUMMARY:Weekly sync',
      'DTSTART:20260720T220000Z',
      'DTEND:20260720T223000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series-1',
      'RECURRENCE-ID:20260727T220000Z',
      'SUMMARY:Weekly sync',
      'DTSTART:20260727T220000Z',
      'DTEND:20260727T223000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/123/calendars/home'), method: 'REPORT' })
      .reply(207, multistatus('/123/calendars/home/series-1.ics', EXPANDED), { headers: XML });

    const { bookings } = await client().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-28T00:00:00Z' },
    });
    expect(bookings.map((b) => b.id)).toEqual([
      'series-1::20260720T220000Z',
      'series-1::20260727T220000Z',
    ]);
    expect(bookings.every((b) => b.seriesId === 'series-1')).toBe(true);
  });

  it('gives an all-day series its instances by date', async () => {
    const EXPANDED = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-day',
      'RECURRENCE-ID;VALUE=DATE:20260721',
      'SUMMARY:Gym',
      'DTSTART;VALUE=DATE:20260721',
      'DTEND;VALUE=DATE:20260722',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/123/calendars/home'), method: 'REPORT' })
      .reply(207, multistatus('/123/calendars/home/series-day.ics', EXPANDED), { headers: XML });

    const { bookings } = await client().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-28T00:00:00Z' },
    });
    expect(bookings.map((b) => b.id)).toEqual(['series-day::20260721']);
  });

  it('leaves a one-off event with its plain resource id and no series', async () => {
    const SINGLE = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:one-off',
      'SUMMARY:Dentist',
      'DTSTART:20260721T100000Z',
      'DTEND:20260721T110000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/123/calendars/home'), method: 'REPORT' })
      .reply(207, multistatus('/123/calendars/home/one-off.ics', SINGLE), { headers: XML });

    const { bookings } = await client().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-28T00:00:00Z' },
    });
    expect(bookings.map((b) => b.id)).toEqual(['one-off']);
    expect(bookings[0]!.seriesId).toBeUndefined();
  });

  it('reads one occurrence from the series master', async () => {
    serve(SERIES);
    const b = await client().getBooking('series-1::20260727T220000Z');
    expect(b.id).toBe('series-1::20260727T220000Z');
    expect(b.seriesId).toBe('series-1');
    expect(b.range).toEqual({ start: '2026-07-27T22:00:00Z', end: '2026-07-27T22:30:00Z' });
    expect(b.title).toBe('Weekly sync');
  });

  it('reports an excluded occurrence as NOT_FOUND', async () => {
    serve(SERIES.replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY\r\nEXDATE:20260727T220000Z'));
    await expect(client().getBooking('series-1::20260727T220000Z')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('moves one occurrence with an override, leaving the series where it was', async () => {
    serve(SERIES);
    const put = capturePut();
    const b = await client().updateBooking('series-1::20260727T220000Z', {
      title: 'Moved sync',
      range: { start: '2026-07-28T09:00:00Z', end: '2026-07-28T09:30:00Z' },
    });

    const [master, override] = vevents(put.body());
    // The master is untouched: same start, still recurring, alarm kept.
    expect(master).toContain('DTSTART:20260720T220000Z');
    expect(master).toContain('RRULE:FREQ=WEEKLY');
    expect(master).toContain('SUMMARY:Weekly sync');
    // The override pins the original occurrence and carries the change.
    expect(override).toContain('RECURRENCE-ID:20260727T220000Z');
    expect(override).toContain('DTSTART:20260728T090000Z');
    expect(override).toContain('DTEND:20260728T093000Z');
    expect(override).toContain('SUMMARY:Moved sync');
    expect(override).toContain('UID:series-1');
    expect(override).not.toContain('RRULE');
    expect(override).toContain('BEGIN:VALARM');
    // Lost-update protection still applies.
    expect(put.headers()['if-match']).toBe('"etag-1"');

    expect(b.id).toBe('series-1::20260727T220000Z');
    expect(b.range).toEqual({ start: '2026-07-28T09:00:00Z', end: '2026-07-28T09:30:00Z' });
    expect(b.title).toBe('Moved sync');
  });

  it('edits an existing override in place instead of adding a second one', async () => {
    const withOverride = SERIES.replace(
      'END:VCALENDAR',
      [
        'BEGIN:VEVENT',
        'UID:series-1',
        'RECURRENCE-ID:20260727T220000Z',
        'DTSTAMP:20260702T000000Z',
        'SUMMARY:Already moved',
        'DTSTART:20260727T230000Z',
        'DTEND:20260727T233000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    serve(withOverride);
    const put = capturePut();
    const b = await client().updateBooking('series-1::20260727T220000Z', { title: 'Renamed' });

    const blocks = vevents(put.body());
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain('SUMMARY:Renamed');
    expect(blocks[1]).toContain('DTSTART:20260727T230000Z');
    expect(blocks[0]).toContain('SUMMARY:Weekly sync');
    expect(b.range.start).toBe('2026-07-27T23:00:00Z');
  });

  it('keeps a zoned series zoned when overriding one occurrence', async () => {
    serve(ZONED);
    const put = capturePut();
    // 27 Jul 09:00 EDT is 13:00Z; move it to 10:00 EDT.
    await client().updateBooking('series-ny::20260727T130000Z', {
      range: { start: '2026-07-27T10:00:00-04:00', end: '2026-07-27T10:30:00-04:00' },
    });
    const [master, override] = vevents(put.body());
    expect(master).toContain('DTSTART;TZID=America/New_York:20260720T090000');
    expect(override).toContain('RECURRENCE-ID;TZID=America/New_York:20260727T090000');
    expect(override).toContain('DTSTART;TZID=America/New_York:20260727T100000');
    expect(override).toContain('DTEND;TZID=America/New_York:20260727T103000');
  });

  it('cancels one occurrence with an EXDATE, not by deleting the series', async () => {
    const withOverride = SERIES.replace(
      'END:VCALENDAR',
      [
        'BEGIN:VEVENT',
        'UID:series-1',
        'RECURRENCE-ID:20260727T220000Z',
        'SUMMARY:Already moved',
        'DTSTART:20260727T230000Z',
        'DTEND:20260727T233000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    serve(withOverride);
    const put = capturePut();
    await client().cancelBooking('series-1::20260727T220000Z');

    const blocks = vevents(put.body());
    // The override for the cancelled occurrence goes; the master excludes it.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('EXDATE:20260727T220000Z');
    expect(blocks[0]).toContain('RRULE:FREQ=WEEKLY');
    expect(put.headers()['if-match']).toBe('"etag-1"');
  });

  it('writes the EXDATE in the series zone', async () => {
    serve(ZONED);
    const put = capturePut();
    await client().cancelBooking('series-ny::20260727T130000Z');
    expect(vevents(put.body())[0]).toContain('EXDATE;TZID=America/New_York:20260727T090000');
  });

  it('rejects an occurrence id on a series with no such occurrence start', async () => {
    serve(SERIES);
    // Not a Monday 22:00Z start: no occurrence of the weekly rule is there.
    await expect(client().getBooking('series-1::20260728T220000Z')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
