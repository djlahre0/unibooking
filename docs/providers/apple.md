# Apple Calendar / CalDAV

```ts
import { apple } from 'unibooking/adapters/apple';
const client = apple({
  username,
  appPassword,
  calendarUrl: 'https://p01-caldav.icloud.com/123456/calendars/home/',
});
```

Works with any CalDAV server (iCloud, Fastmail, Nextcloud, …) — it speaks WebDAV
+ iCalendar rather than JSON.

**Credentials:** `{ username, appPassword, calendarUrl }`.
- For iCloud, create an **app-specific password** (Apple ID → Sign-In & Security).
- `calendarUrl` is the full calendar-collection URL. This package does **not**
  run principal discovery; find the collection URL once (via a CalDAV client or
  a `PROPFIND` on `/.well-known/caldav`) and pass it in.

**Capabilities:** plain calendar — no availability/staff/services/webhooks.
`idempotency` is honored via the event UID (pass `idempotencyKey`).

**Gotchas**
- `listBookings` issues a CalDAV `calendar-query` `REPORT` filtered by time range,
  and ids each booking by its DAV resource href — so `getBooking`/`updateBooking`/
  `cancelBooking` address the right resource even when a server stored the event
  under a name that isn't its iCal UID.
- `updateBooking` GETs the current `.ics`, patches only the fields you changed
  (preserving `RRULE`, `LOCATION`, `DESCRIPTION`, extra attendees, alarms, and
  `VTIMEZONE`), and PUTs it back with an `If-Match` ETag for optimistic-concurrency
  (a concurrent edit fails with 412 rather than being silently clobbered).
- `cancelBooking` deletes the resource.
- Times: `Z` and `TZID=`-qualified events convert to correct instants (via the
  platform `Intl` time-zone database); floating (zone-less) times are treated as
  UTC.
