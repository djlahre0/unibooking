# Outlook / Microsoft 365 (Microsoft Graph)

> **Corrected 2026-07-20.** A non-URL `pageToken` was forwarded as `$skiptoken`, which Graph ignores — callers looped on page 1 forever. Event ids are now requested as immutable. See CHANGELOG 0.2.0.

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
  (The header controls only the *response* time zone — the `calendarView` query
  window is always governed by the offset in the `start`/`end` instants you pass.)
- `listBookings` uses `calendarView` (recurrences expanded into single instances)
  and pages by following the full `@odata.nextLink` URL verbatim, so both
  `$skiptoken`- and `$skip`-based paging work. The returned `nextPageToken` *is*
  that URL — pass it straight back as `pageToken`.
- `cancelBooking()` deletes the event. `cancelBooking(id, { notify: true })` or
  `{ reason }` instead POSTs Graph's `/cancel` action, which sends a cancellation
  message to attendees. **`/cancel` is organizer-only:** Graph returns `400` if
  the caller isn't the meeting organizer, and it targets meetings (events with
  attendees). For a personal, attendee-less event, cancel *without* `notify`/`reason`
  so the adapter issues a plain `DELETE`.
- `idempotencyKey` maps to the event `transactionId` (set once at create; Graph
  uses it to de-duplicate a retried create). Its exact retry response isn't
  documented by Microsoft — don't branch on a specific status for a replay.

**Webhooks:** `unibooking/webhooks/outlook`:
- `graphValidationToken(query)` — echo it back as `text/plain` on subscription
  creation.
- `verifyGraphClientState(payload, expected)` — compare the `clientState` you set
  (Graph caps `clientState` at 128 chars).
- Event subscriptions expire within ~7 days (`10080` minutes) max — renew before
  then; Graph doesn't auto-renew.
