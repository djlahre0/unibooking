/**
 * Fixtures follow RFC 4791 / RFC 5397 multistatus shapes and iCloud's real
 * habits: a relative principal href, a calendar-home-set on a DIFFERENT
 * partition host written with an explicit `:443`, Apple's `calendar-color`
 * with an alpha byte, a VTODO-only Reminders collection, and a 404 propstat
 * for a property the server doesn't have.
 */
export const ROOT = 'https://caldav.icloud.com';
export const PARTITION = 'https://p57-caldav.icloud.com';

export const PRINCIPAL_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop>` +
  `<d:current-user-principal><d:href>/123456/principal/</d:href></d:current-user-principal>` +
  `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

export const HOME_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<multistatus xmlns="DAV:"><response><href>/123456/principal/</href><propstat><prop>` +
  `<calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav">` +
  `<href xmlns="DAV:">https://p57-caldav.icloud.com:443/123456/calendars/</href>` +
  `</calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

export const LIST_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">` +
  // The home collection itself: a collection, not a calendar.
  `<d:response><d:href>/123456/calendars/</d:href><d:propstat><d:prop>` +
  `<d:resourcetype><d:collection/></d:resourcetype>` +
  `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  // A writable event calendar with every property.
  `<d:response><d:href>/123456/calendars/home/</d:href><d:propstat><d:prop>` +
  `<d:displayname>Home &amp; Family</d:displayname>` +
  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
  `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
  `<a:calendar-color>#FF2968FF</a:calendar-color>` +
  `<c:calendar-timezone>BEGIN:VCALENDAR&#13;\nBEGIN:VTIMEZONE&#13;\nTZID:Asia/Kolkata&#13;\nEND:VTIMEZONE&#13;\nEND:VCALENDAR</c:calendar-timezone>` +
  `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>` +
  `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  // Reminders: VTODO only, so not an event calendar.
  `<d:response><d:href>/123456/calendars/reminders/</d:href><d:propstat><d:prop>` +
  `<d:displayname>Reminders</d:displayname>` +
  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
  `<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>` +
  `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
  // A read-only shared calendar whose color is missing (404 propstat).
  `<d:response><d:href>/123456/calendars/shared/</d:href><d:propstat><d:prop>` +
  `<d:displayname>Shared</d:displayname>` +
  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
  `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>` +
  `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
  `<d:propstat><d:prop><a:calendar-color>#00FF00</a:calendar-color></d:prop>` +
  `<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>` +
  `</d:multistatus>`;
