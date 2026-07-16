# Outlook / Microsoft 365 (Microsoft Graph)

```ts
import { outlook } from 'unibooking/adapters/outlook';
const cal = outlook({ accessToken, userId?, calendarId? });
```

**Credentials:** `{ accessToken, userId?, calendarId? }`. Defaults to the signed-in
user's default calendar (`me`). Set `userId` for app-permission access to another
user's calendar.

**OAuth scope:** `Calendars.ReadWrite` (delegated) or the application equivalent.

**Capabilities:** plain calendar — no availability/staff/services.
`idempotency` maps to Graph's event `transactionId`.

**Gotchas**
- Graph returns times without an offset; the adapter sends
  `Prefer: outlook.timezone="UTC"` and normalizes everything to UTC instants.
- `listBookings` uses `calendarView` (recurrences expanded) and pages via the
  opaque `$skiptoken` extracted from `@odata.nextLink`.
- `cancelBooking` deletes the event.

**Webhooks:** `unibooking/webhooks/outlook`:
- `graphValidationToken(query)` — echo it back as `text/plain` on subscription
  creation.
- `verifyGraphClientState(payload, expected)` — compare the `clientState` you set.
