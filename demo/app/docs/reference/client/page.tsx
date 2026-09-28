import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Code, DocPage, H2 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'BookingClient',
  description: 'Every method on a client, what it needs and what it returns.',
  href: '/docs/reference/client',
});

type Row = [method: string, returns: string, flag: string, note: string];

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: 'Bookings',
    rows: [
      [
        'createBooking(input)',
        'Booking',
        '-',
        'title, range; plus serviceId / staffId / customer where the provider needs them.',
      ],
      ['getBooking(id)', 'Booking', '-', 'Throws NOT_FOUND for an unknown id.'],
      [
        'updateBooking(id, input)',
        'Booking',
        '-',
        'Partial: omitted fields are left alone. ifVersion needs versionedWrites.',
      ],
      ['cancelBooking(id, options?)', 'void', '-', 'reason, notify, ifVersion, providerOptions.'],
      [
        'listBookings(query)',
        '{ bookings, nextPageToken? }',
        '-',
        'range required; staffId, customerId, status, limit, pageToken.',
      ],
      [
        'searchAvailability(query)',
        'AvailabilitySlot[]',
        'availability',
        'Sorted by start. Slot rules apply where the provider derives slots from busy time.',
      ],
      [
        'checkConnection()',
        'ConnectionStatus',
        '-',
        'Dead credentials are returned as ok: false, not thrown.',
      ],
    ],
  },
  {
    title: 'Catalog and staff',
    rows: [
      [
        'listServices(query?) / getService(id)',
        'Service',
        'serviceCatalog',
        'Service.id is exactly what createBooking accepts.',
      ],
      ['createService / updateService / setServiceActive', 'Service', 'serviceCatalogWrite', ''],
      ['deleteService(id)', 'void', 'serviceDelete', ''],
      ['listStaff(query?) / getStaff(id)', 'Staff', 'staffDirectory', ''],
      [
        'createStaff / updateStaff',
        'Staff',
        'staffDirectoryWrite',
        'update*({ active }) needs staffDeactivate.',
      ],
      ['setStaffActive(id, active)', 'Staff', 'staffDeactivate', ''],
      ['deleteStaff(id)', 'void', 'staffDelete', ''],
      [
        'assignStaffToService / unassignStaffFromService',
        'Service',
        'staffServiceAssignmentWrite',
        'Idempotent.',
      ],
      ['listCategories()', '{ categories }', 'serviceCategories', ''],
      [
        'getBusinessHours()',
        'BusinessHours',
        'businessHours',
        'Weekly wall-clock periods in a zone.',
      ],
    ],
  },
  {
    title: 'Customers',
    rows: [
      [
        'customers.findOrCreate(customer)',
        'string (id)',
        'customers',
        'Matches by email or phone before creating.',
      ],
      ['customers.list / customers.get', 'CustomerRecord', 'customerDirectory', ''],
      ['customers.create / customers.update', 'CustomerRecord', 'customerWrite', ''],
      ['customers.delete(id)', 'void', 'customerDelete', ''],
    ],
  },
  {
    title: 'Calendars and sync',
    rows: [
      [
        'listCalendars(query?) / getCalendar(id)',
        'Calendar',
        'calendarList',
        'Calendar.id is what the adapter accepts as its calendar.',
      ],
      [
        'createCalendar / updateCalendar / deleteCalendar',
        'Calendar',
        'calendarWrite',
        'The primary calendar cannot be deleted.',
      ],
      [
        'syncBookings(query?)',
        '{ changes, nextPageToken?, syncToken? }',
        'changeFeed',
        'fullSyncRequired when the token expired.',
      ],
      ['watchBookings / renewWatch / stopWatch', 'Watch', 'changeNotifications', ''],
    ],
  },
  {
    title: 'Classes',
    rows: [
      [
        'listClasses(query?) / getClass(id)',
        'ClassSession',
        'classCatalog',
        'capacity, booked, available, full.',
      ],
      [
        'enrollInClass(input)',
        'Booking',
        'classEnrollment',
        'allowWaitlist needs classWaitlist; a full class throws CONFLICT.',
      ],
    ],
  },
];

export default function ClientReference() {
  return (
    <DocPage
      href="/docs/reference/client"
      title="BookingClient"
      lead="Every adapter returns a BookingClient. The first seven methods exist on every client; the rest exist only when the matching capability flag is true."
    >
      <Code title="The shape of a result">{`
type Booking = {
  id: string;
  provider: ProviderId;
  title: string;
  range: { start: string; end: string; timezone?: string };
  status: 'confirmed' | 'pending' | 'cancelled' | 'declined'
        | 'no_show' | 'completed' | 'waitlisted' | 'unknown';
  customer?: { id?: string; name?: string; email?: string; phone?: string };
  staffId?: string;
  serviceId?: string;
  description?: string; // calendar providers
  location?: string;    // calendar providers
  allDay?: boolean;
  seriesId?: string;    // one occurrence of a recurring series
  version?: string;     // pass back as ifVersion
  raw: unknown;         // the provider's original object
};
`}</Code>

      {GROUPS.map((g) => (
        <section key={g.title}>
          <H2>{g.title}</H2>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Returns</th>
                <th>Requires</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map(([m, r, flag, note]) => (
                <tr key={m}>
                  <td>
                    <code>{m}</code>
                  </td>
                  <td>
                    <code>{r}</code>
                  </td>
                  <td>{flag === '-' ? '-' : <code>{flag}</code>}</td>
                  <td>{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <H2>Writes and providerOptions</H2>
      <p>
        Every write accepts <code>providerOptions</code>, merged into the outgoing request after the
        adapter builds it, for provider fields with no canonical equivalent. Each{' '}
        <Link href="/docs/providers">provider page</Link> names the keys its adapter reads itself.
      </p>
    </DocPage>
  );
}
