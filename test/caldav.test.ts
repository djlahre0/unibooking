import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { createHttp } from '../src/http';
import { davProp, davResponses, discoverCalendars, findPrincipal } from '../src/caldav';
import { assertCanonicalCalendar } from './conformance';
import { HOME_XML, LIST_XML, PARTITION, PRINCIPAL_XML, ROOT } from './caldav-fixtures';

const XML = { 'content-type': 'application/xml; charset=utf-8' };

type Creds = { username: string; appPassword: string };

function http() {
  return createHttp<Creds>({
    provider: 'apple',
    baseUrl: `${ROOT}/`,
    creds: { username: 'jane@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' },
    auth: (c) => ({
      headers: { authorization: `Basic ${btoa(`${c.username}:${c.appPassword}`)}` },
    }),
    // As the apple adapter declares it: discovery follows iCloud onto its
    // partition host, which the HTTP layer otherwise refuses.
    allowCrossOrigin: true,
  });
}

describe('multistatus reader', () => {
  it('keeps only 2xx propstats and matches elements by local name', () => {
    const [, , , shared] = davResponses(LIST_XML);
    expect(shared?.href).toBe('/123456/calendars/shared/');
    expect(davProp(shared!.props, 'displayname')).toBe('Shared');
    // The 404 propstat's value must not leak through.
    expect(davProp(shared!.props, 'calendar-color')).toBeUndefined();
  });
});

describe('CalDAV discovery', () => {
  let agent: MockAgent;
  let previous: Dispatcher;
  const depths: string[] = [];

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    depths.length = 0;
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  function interceptAll() {
    const record = (xml: string) => (opts: { headers?: unknown }) => {
      depths.push(String(new Headers(opts.headers as HeadersInit).get('depth')));
      return xml;
    };
    agent
      .get(ROOT)
      .intercept({ path: '/', method: 'PROPFIND' })
      .reply(207, record(PRINCIPAL_XML), { headers: XML });
    agent
      .get(ROOT)
      .intercept({ path: '/123456/principal/', method: 'PROPFIND' })
      .reply(207, record(HOME_XML), { headers: XML });
    agent
      .get(PARTITION)
      .intercept({ path: '/123456/calendars/', method: 'PROPFIND' })
      .reply(207, record(LIST_XML), { headers: XML });
  }

  it('walks principal -> calendar home -> calendars and maps each event calendar', async () => {
    interceptAll();
    const h = http();
    const calendars = await discoverCalendars(h, await h.resolve(), 'apple');

    expect(depths).toEqual(['0', '0', '1']);
    expect(calendars).toHaveLength(2);
    const [home, shared] = calendars;
    expect(home).toMatchObject({
      id: 'https://p57-caldav.icloud.com/123456/calendars/home/',
      name: 'Home & Family',
      timezone: 'Asia/Kolkata',
      color: '#FF2968',
      primary: false,
      readOnly: false,
    });
    expect(shared).toMatchObject({ name: 'Shared', readOnly: true });
    expect(shared?.color).toBeUndefined();
    for (const c of calendars) assertCanonicalCalendar(c);
    agent.assertNoPendingInterceptors();
  });

  it('reports UPSTREAM when the server names no principal', async () => {
    agent
      .get(ROOT)
      .intercept({ path: '/', method: 'PROPFIND' })
      .reply(207, `<d:multistatus xmlns:d="DAV:"></d:multistatus>`, { headers: XML });
    const h = http();
    await expect(findPrincipal(h, await h.resolve(), 'apple')).rejects.toMatchObject({
      code: 'UPSTREAM',
    });
  });

  it('maps a rejected app password to AUTH', async () => {
    agent.get(ROOT).intercept({ path: '/', method: 'PROPFIND' }).reply(401, '');
    const h = http();
    await expect(findPrincipal(h, await h.resolve(), 'apple')).rejects.toMatchObject({
      code: 'AUTH',
    });
  });
});
