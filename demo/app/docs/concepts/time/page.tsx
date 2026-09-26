import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import { Callout, Code, DocPage, H2 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Times & ranges',
  description: 'Offset-bearing instants, display time zones and all-day events.',
  href: '/docs/concepts/time',
});

export default function Time() {
  return (
    <DocPage
      href="/docs/concepts/time"
      title="Times & ranges"
      lead="Providers disagree about time: some return UTC, some local wall-clock with no zone, one returns US Eastern whatever the business's zone. unibooking gives you one rule instead."
    >
      <H2>The rule: instants with an offset</H2>
      <p>
        Every time you pass in and every time you get back is an RFC 3339 timestamp{' '}
        <strong>with an offset</strong>: <code>2026-10-02T14:00:00+01:00</code> or{' '}
        <code>2026-10-02T13:00:00Z</code>. Both name the same instant. A string without an offset is
        rejected with <code>INVALID_INPUT</code> before any request is sent: an ambiguous time is
        never guessed.
      </p>
      <Code>{`
type TimeRange = {
  start: string;     // '2026-10-02T14:00:00+01:00'
  end: string;       // must be after start
  timezone?: string; // IANA, e.g. 'Europe/London': display only
};
`}</Code>

      <H2>What timezone does</H2>
      <p>
        <code>timezone</code> never changes which instant is meant. Providers that store a display
        zone (Google, Outlook) receive it, so the event shows in that zone in their own apps; the
        provider pages note the few that need it to interpret local times (Wix and Setmore
        availability).
      </p>

      <H2>From a date and time in a zone</H2>
      <p>
        Forms usually collect a date, a time and a zone. Convert them with{' '}
        <code>zonedToInstant</code> rather than building offsets by hand. It handles daylight
        saving:
      </p>
      <Code>{`
import { zonedToInstant, instantToZoned } from 'unibooking';

zonedToInstant('2026-10-25T09:00', 'Europe/London');
// → '2026-10-25T09:00:00Z' (British Summer Time has ended)

instantToZoned('2026-10-25T09:00:00Z', 'America/New_York');
// → { date: '2026-10-25', time: '05:00' }
`}</Code>

      <H2>All-day events</H2>
      <p>
        Calendar providers support <code>allDay: true</code>. The event&apos;s dates are the
        calendar dates of <code>range.start</code> and <code>range.end</code> as written, with the
        end exclusive. Read back, an all-day booking holds UTC midnights:
      </p>
      <Code>{`
await client.createBooking({
  title: 'Offsite',
  allDay: true,
  range: { start: '2026-10-21T00:00:00+05:30', end: '2026-10-22T00:00:00+05:30' },
});
// Read back: range = { start: '2026-10-21T00:00:00Z', end: '2026-10-22T00:00:00Z' }, allDay: true
`}</Code>

      <H2>Durations and slots</H2>
      <p>
        Some providers return only slot <em>start</em> times (Acuity, Calendly, Setmore, Zenoti) or
        only busy time (Google, Outlook). Their <code>searchAvailability</code> needs a positive{' '}
        <code>durationMinutes</code> to size each slot, and says so if it is missing.
      </p>
      <Callout type="tip" title="Combining sources yourself">
        <code>computeSlots</code> turns working hours, busy intervals and rules (buffers, notice,
        interval) into free slots: the same function the calendar adapters use.
      </Callout>
    </DocPage>
  );
}
