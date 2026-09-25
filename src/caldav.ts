import type { Calendar, ProviderId } from './types';
import type { HttpContext } from './http';
import { UnibookingError } from './errors';
import { hexColor } from './adapter-kit';
import { unescapeXml } from './ical';

/**
 * CalDAV discovery (RFC 4791 §6, RFC 5397): from a server root to the account's
 * calendar collections, so a caller needs an account and a password — never a
 * collection URL nobody outside the server knows. Three PROPFINDs:
 *
 *   1. root, Depth 0      → `current-user-principal`
 *   2. principal, Depth 0 → `calendar-home-set`
 *   3. home, Depth 1      → one response per collection
 *
 * Every href is resolved against the URL of the response that carried it.
 * iCloud answers step 2 with an absolute href on a different partition host
 * (`https://p57-caldav.icloud.com:443/…`), so resolving against the configured
 * base would be wrong; `new URL` also normalizes the default port away.
 *
 * Parsing is regex-based and prefix-tolerant, in the same style as the
 * multistatus reader in `ical.ts`: servers choose their own namespace prefixes
 * (`d:`, `D:`, none), so elements are matched by local name.
 */

const NS =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"';
const XML_HEADERS = { accept: 'application/xml', 'content-type': 'application/xml; charset=utf-8' };

function propfindBody(props: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`;
}

/** Element `name` in any (or no) namespace prefix, capturing its inner XML. A
 *  self-closing `<d:foo/>` deliberately does not match: it carries no value. */
function element(name: string, flags = 'i'): RegExp {
  return new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    flags,
  );
}

/** Every `<response>` in a multistatus: its href and the XML of its 2xx
 *  propstats only. A server reports properties it lacks in a separate 404
 *  propstat, sometimes with an empty or placeholder value that must not be
 *  read as real. */
export function davResponses(xml: string): Array<{ href: string; props: string }> {
  const out: Array<{ href: string; props: string }> = [];
  for (const block of xml.match(element('response', 'gi')) ?? []) {
    const href = element('href').exec(block)?.[1];
    if (!href) continue;
    const props = (block.match(element('propstat', 'gi')) ?? [])
      .filter((ps) => /\s2\d\d\s/.test(element('status').exec(ps)?.[1] ?? ''))
      .join('');
    out.push({ href: unescapeXml(href.trim()), props });
  }
  return out;
}

/** Inner XML of the first element named `name`, or undefined. */
export function davProp(props: string, name: string): string | undefined {
  return element(name).exec(props)?.[1];
}

// --- sync-collection (RFC 6578) ----------------------------------------------

/** The body of a DAV:sync-collection REPORT asking for each changed member's
 *  ETag and iCalendar data. An empty token asks for every member. */
export function syncCollectionBody(syncToken: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:sync-collection ${NS}>` +
    `<d:sync-token>${escapeXml(syncToken)}</d:sync-token>` +
    `<d:sync-level>1</d:sync-level>` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `</d:sync-collection>`
  );
}

/** A calendar-multiget REPORT for members a sync reported without their data. */
export function multigetBody(hrefs: string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<c:calendar-multiget ${NS}>` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    hrefs.map((h) => `<d:href>${escapeXml(h)}</d:href>`).join('') +
    `</c:calendar-multiget>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SyncEntry {
  href: string;
  /** 404 for a removed member (RFC 6578 §3.5.2); the propstat status otherwise. */
  status: number;
  etag?: string;
  ics?: string;
}

export interface SyncCollectionResult {
  entries: SyncEntry[];
  syncToken?: string;
  /** The server stopped early (507 on the request-URI, RFC 6578 §3.6): call
   *  again with `syncToken` for the rest. */
  truncated: boolean;
}

function statusCode(text: string | undefined): number {
  const m = /\s(\d{3})\s?/.exec(text ?? '');
  return m ? Number(m[1]) : 0;
}

/** Read a sync-collection multistatus. `collectionUrl` identifies the
 *  request-URI's own response, which carries the 507 of a truncated result. */
export function parseSyncCollection(xml: string, collectionUrl: string): SyncCollectionResult {
  const entries: SyncEntry[] = [];
  let truncated = false;
  const selfPath = new URL(collectionUrl).pathname.replace(/\/+$/, '');
  for (const block of xml.match(element('response', 'gi')) ?? []) {
    const href = element('href').exec(block)?.[1];
    if (!href) continue;
    const decoded = unescapeXml(href.trim());
    const propstats = block.match(element('propstat', 'gi')) ?? [];
    // A removed member has a response-level status and no propstat; so does
    // the truncation marker on the collection itself.
    const outer = block.replace(element('propstat', 'gi'), '');
    const outerStatus = statusCode(element('status').exec(outer)?.[1]);
    let path = decoded;
    try {
      path = new URL(decoded, collectionUrl).pathname;
    } catch {
      // Keep the raw href.
    }
    if (path.replace(/\/+$/, '') === selfPath) {
      if (outerStatus === 507) truncated = true;
      continue;
    }
    if (propstats.length === 0) {
      entries.push({ href: decoded, status: outerStatus || 404 });
      continue;
    }
    const ok = propstats.find((ps) => statusCode(element('status').exec(ps)?.[1]) < 300);
    const data = ok ? davProp(ok, 'calendar-data') : undefined;
    const etag = ok ? davProp(ok, 'getetag') : undefined;
    entries.push({
      href: decoded,
      status: ok ? 200 : statusCode(element('status').exec(propstats[0]!)?.[1]),
      ...(etag?.trim() ? { etag: unescapeXml(etag.trim()) } : {}),
      ...(data?.trim() ? { ics: unescapeXml(data).trim() } : {}),
    });
  }
  // The new token is a direct child of the multistatus, after the responses.
  const tail = xml.replace(element('response', 'gi'), '');
  const token = element('sync-token').exec(tail)?.[1]?.trim();
  return { entries, ...(token ? { syncToken: unescapeXml(token) } : {}), truncated };
}

async function propfind<T>(
  http: HttpContext<T>,
  creds: T,
  path: string,
  depth: 0 | 1,
  props: string,
): Promise<{ xml: string; url: string }> {
  let url = '';
  const xml = await http.request<string>(creds, {
    method: 'PROPFIND',
    path,
    headers: { ...XML_HEADERS, depth: String(depth) },
    body: propfindBody(props),
    parse: 'text',
    onResponse: (meta) => {
      url = meta.url;
    },
  });
  return { xml: xml ?? '', url };
}

/** The absolute URL held in property `prop` of the first response that has it. */
function hrefProperty(provider: ProviderId, xml: string, base: string, prop: string): string {
  for (const r of davResponses(xml)) {
    const inner = davProp(r.props, prop);
    const href = inner !== undefined ? davProp(inner, 'href') : undefined;
    if (href) return new URL(unescapeXml(href.trim()), base).toString();
  }
  throw new UnibookingError({
    provider,
    code: 'UPSTREAM',
    message: `CalDAV discovery: the server did not report ${prop}`,
  });
}

/** The principal URL for the credentials, found from the server root. This is
 *  also the cheapest authenticated request a CalDAV server offers. */
export async function findPrincipal<T>(
  http: HttpContext<T>,
  creds: T,
  provider: ProviderId,
): Promise<string> {
  const { xml, url } = await propfind(http, creds, '', 0, '<d:current-user-principal/>');
  return hrefProperty(provider, xml, url, 'current-user-principal');
}

/** Every event-capable calendar collection the credentials can see. */
export async function discoverCalendars<T>(
  http: HttpContext<T>,
  creds: T,
  provider: ProviderId,
): Promise<Calendar[]> {
  const principal = await findPrincipal(http, creds, provider);
  const home = await propfind(http, creds, principal, 0, '<c:calendar-home-set/>');
  const homeUrl = hrefProperty(provider, home.xml, home.url, 'calendar-home-set');
  const list = await propfind(
    http,
    creds,
    homeUrl,
    1,
    '<d:displayname/><d:resourcetype/><d:current-user-privilege-set/>' +
      '<c:supported-calendar-component-set/><c:calendar-timezone/><a:calendar-color/>',
  );
  return davResponses(list.xml).flatMap((r) => toCalendar(r, list.url));
}

function toCalendar(r: { href: string; props: string }, base: string): Calendar[] {
  // Only calendar collections (not the home itself, not scheduling inboxes)…
  if (!/<(?:[\w-]+:)?calendar[\s/>]/i.test(davProp(r.props, 'resourcetype') ?? '')) return [];
  // …that hold events. An absent component set means "any component" (RFC 4791 §5.2.3).
  const components = davProp(r.props, 'supported-calendar-component-set');
  if (components !== undefined && !/name\s*=\s*["']VEVENT["']/i.test(components)) return [];

  const id = new URL(r.href, base).toString();
  const name = unescapeXml(davProp(r.props, 'displayname') ?? '').trim();
  const timezone = /TZID:([^\r\n]+)/
    .exec(unescapeXml(davProp(r.props, 'calendar-timezone') ?? ''))?.[1]
    ?.trim();
  // An absent privilege set means the server did not say. Treating that as
  // read-only would disable a calendar the user can in fact write to.
  const privileges = davProp(r.props, 'current-user-privilege-set');
  const readOnly =
    privileges !== undefined &&
    !/<(?:[\w-]+:)?(?:write|write-content|bind|all)[\s/>]/i.test(privileges);
  const color = hexColor(unescapeXml(davProp(r.props, 'calendar-color') ?? ''));
  const lastSegment = id.replace(/\/+$/, '').split('/').pop() ?? id;

  return [
    {
      id,
      name: name || decodeURIComponent(lastSegment),
      ...(timezone ? { timezone } : {}),
      primary: false,
      readOnly,
      ...(color ? { color } : {}),
      raw: r,
    },
  ];
}
