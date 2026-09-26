import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { google } from '../../src/adapters/google';
import { outlook } from '../../src/adapters/outlook';
import { apple } from '../../src/adapters/apple';
import { HOME_XML, LIST_XML, PARTITION, PRINCIPAL_XML, ROOT as DAV_ROOT } from '../caldav-fixtures';

// createCalendar / updateCalendar / deleteCalendar against each calendar
// provider's own API. The provider owns the calendar; these only ask it to
// make, change or remove one.

const JSON_HEADERS = { 'content-type': 'application/json' };
const XML = { 'content-type': 'application/xml; charset=utf-8' };

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

describe('google: calendar writes', () => {
  const ORIGIN = 'https://www.googleapis.com';
  const client = () => google({ accessToken: 't' });
  const ENTRY = {
    id: 'cal1@group.calendar.google.com',
    summary: 'Salon',
    timeZone: 'Europe/Dublin',
    accessRole: 'owner',
    backgroundColor: '#0f5c4a',
  };
  const ENTRY_PATH = `/calendar/v3/users/me/calendarList/${encodeURIComponent(ENTRY.id)}`;

  it('create posts the calendar, then sets its colour on the list entry', async () => {
    let created: any;
    let colour: any;
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: '/calendar/v3/calendars', method: 'POST' }).reply(
      200,
      (o) => {
        created = JSON.parse(String(o.body));
        return JSON.stringify({ id: ENTRY.id, summary: 'Salon' });
      },
      { headers: JSON_HEADERS },
    );
    pool
      .intercept({
        path: (p) => p.startsWith(`${ENTRY_PATH}?colorRgbFormat=true`),
        method: 'PATCH',
      })
      .reply(
        200,
        (o) => {
          colour = JSON.parse(String(o.body));
          return JSON.stringify(ENTRY);
        },
        { headers: JSON_HEADERS },
      );
    const cal = await client().createCalendar!({
      name: 'Salon',
      timezone: 'Europe/Dublin',
      color: '#0F5C4A',
    });
    expect(created).toEqual({ summary: 'Salon', timeZone: 'Europe/Dublin' });
    expect(colour).toEqual({ backgroundColor: '#0F5C4A', foregroundColor: '#ffffff' });
    // An owner entry, so the new calendar is writable.
    expect(cal).toMatchObject({ id: ENTRY.id, name: 'Salon', readOnly: false });
  });

  it('update renames via /calendars and returns the list entry', async () => {
    let body: any;
    const pool = agent.get(ORIGIN);
    pool
      .intercept({
        path: `/calendar/v3/calendars/${encodeURIComponent(ENTRY.id)}`,
        method: 'PATCH',
      })
      .reply(
        200,
        (o) => {
          body = JSON.parse(String(o.body));
          return JSON.stringify({ id: ENTRY.id });
        },
        { headers: JSON_HEADERS },
      );
    pool
      .intercept({ path: ENTRY_PATH, method: 'GET' })
      .reply(200, JSON.stringify({ ...ENTRY, summary: 'Salon 2' }), { headers: JSON_HEADERS });
    const cal = await client().updateCalendar!(ENTRY.id, { name: 'Salon 2' });
    expect(body).toEqual({ summary: 'Salon 2' });
    expect(cal.name).toBe('Salon 2');
  });

  it('refuses to delete the primary calendar before calling Google', async () => {
    await expect(client().deleteCalendar!('primary')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a colour that is not #RRGGBB', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/calendar/v3/calendars', method: 'POST' })
      .reply(200, JSON.stringify({ id: ENTRY.id }), { headers: JSON_HEADERS });
    await expect(client().createCalendar!({ name: 'X', color: 'green' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('outlook: calendar writes', () => {
  const ORIGIN = 'https://graph.microsoft.com';
  const client = () => outlook({ accessToken: 't' });

  it('create and rename go to /me/calendars', async () => {
    let created: any;
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: '/v1.0/me/calendars', method: 'POST' }).reply(
      201,
      (o) => {
        created = JSON.parse(String(o.body));
        return JSON.stringify({ id: 'AAMk1', name: 'Salon', canEdit: true });
      },
      { headers: JSON_HEADERS },
    );
    const cal = await client().createCalendar!({
      name: 'Salon',
      providerOptions: { color: 'lightBlue' },
    });
    expect(created).toEqual({ name: 'Salon', color: 'lightBlue' });
    expect(cal).toMatchObject({ id: 'AAMk1', name: 'Salon', readOnly: false });

    pool
      .intercept({ path: '/v1.0/me/calendars/AAMk1', method: 'PATCH' })
      .reply(200, JSON.stringify({ id: 'AAMk1', name: 'Salon 2' }), { headers: JSON_HEADERS });
    expect((await client().updateCalendar!('AAMk1', { name: 'Salon 2' })).name).toBe('Salon 2');
  });

  it('refuses to delete the default calendar', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/v1.0/me/calendars/AAMk0', method: 'GET' })
      .reply(200, JSON.stringify({ id: 'AAMk0', name: 'Calendar', isDefaultCalendar: true }), {
        headers: JSON_HEADERS,
      });
    await expect(client().deleteCalendar!('AAMk0')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('deletes any other calendar', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/v1.0/me/calendars/AAMk1', method: 'GET' })
      .reply(200, JSON.stringify({ id: 'AAMk1', name: 'Salon' }), { headers: JSON_HEADERS });
    pool.intercept({ path: '/v1.0/me/calendars/AAMk1', method: 'DELETE' }).reply(204, '');
    await client().deleteCalendar!('AAMk1');
  });
});

describe('apple (CalDAV): calendar writes', () => {
  const CREDS = { username: 'u', appPassword: 'p' };
  const discovery = () => {
    agent
      .get(DAV_ROOT)
      .intercept({ path: '/', method: 'PROPFIND' })
      .reply(207, PRINCIPAL_XML, { headers: XML });
    agent
      .get(DAV_ROOT)
      .intercept({ path: '/123456/principal/', method: 'PROPFIND' })
      .reply(207, HOME_XML, { headers: XML });
  };

  it('create makes a VEVENT calendar inside the calendar home', async () => {
    discovery();
    let path = '';
    let body = '';
    agent
      .get(PARTITION)
      .intercept({ path: (p) => p.startsWith('/123456/calendars/'), method: 'MKCALENDAR' })
      .reply(
        201,
        (o) => {
          path = String(o.path);
          body = String(o.body);
          return '';
        },
        { headers: XML },
      );
    const cal = await apple(CREDS).createCalendar!({ name: 'Salon & Spa', color: '#0f5c4a' });
    expect(path).toMatch(/^\/123456\/calendars\/[0-9a-f-]{36}\/$/);
    expect(body).toContain('<d:displayname>Salon &amp; Spa</d:displayname>');
    expect(body).toContain('<c:comp name="VEVENT"/>');
    expect(body).toContain('<a:calendar-color>#0F5C4AFF</a:calendar-color>');
    expect(cal).toMatchObject({ name: 'Salon & Spa', readOnly: false, id: `${PARTITION}${path}` });
  });

  it('update PROPPATCHes a calendar in the home and returns it re-read', async () => {
    discovery();
    discovery();
    let body = '';
    agent
      .get(PARTITION)
      .intercept({ path: '/123456/calendars/home/', method: 'PROPPATCH' })
      .reply(
        207,
        (o) => {
          body = String(o.body);
          return '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
        },
        { headers: XML },
      );
    agent
      .get(PARTITION)
      .intercept({ path: '/123456/calendars/', method: 'PROPFIND' })
      .reply(207, LIST_XML, { headers: XML });
    const cal = await apple(CREDS).updateCalendar!(`${PARTITION}/123456/calendars/home/`, {
      name: 'Home',
    });
    expect(body).toContain('<d:displayname>Home</d:displayname>');
    expect(cal.id).toBe(`${PARTITION}/123456/calendars/home/`);
  });

  it('a refused property is an error, not a silent success', async () => {
    discovery();
    agent
      .get(PARTITION)
      .intercept({ path: '/123456/calendars/home/', method: 'PROPPATCH' })
      .reply(
        207,
        '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>',
        { headers: XML },
      );
    await expect(
      apple(CREDS).updateCalendar!(`${PARTITION}/123456/calendars/home/`, { name: 'X' }),
    ).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('never sends a request (or the credentials) to a calendar outside the home', async () => {
    discovery();
    // No interceptor for evil.example: reaching it would fail the test with a
    // network error rather than INVALID_INPUT.
    await expect(
      apple(CREDS).deleteCalendar!('https://evil.example/123456/calendars/home/'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    discovery();
    await expect(
      apple(CREDS).deleteCalendar!(`${PARTITION}/123456/calendars/`),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('deletes a calendar in the home', async () => {
    discovery();
    agent
      .get(PARTITION)
      .intercept({ path: '/123456/calendars/home/', method: 'DELETE' })
      .reply(204, '');
    await apple(CREDS).deleteCalendar!(`${PARTITION}/123456/calendars/home/`);
  });
});
