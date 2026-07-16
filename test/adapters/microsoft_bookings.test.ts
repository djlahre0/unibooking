import { expect } from 'vitest';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { runConformance } from '../conformance';

const APPT = {
  id: 'a1',
  serviceId: 'svc1',
  serviceName: 'Haircut',
  staffMemberIds: ['staff1'],
  startDateTime: { dateTime: '2026-07-20T22:00:00.0000000', timeZone: 'UTC' },
  endDateTime: { dateTime: '2026-07-20T22:45:00.0000000', timeZone: 'UTC' },
  customers: [{ name: 'Jane', emailAddress: 'jane@example.com' }],
};

const BIZ = 'contoso@contoso.onmicrosoft.com';
const APPTS = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}/appointments`;
const VIEW = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}/calendarView`;
const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'microsoft_bookings',
  origin: 'https://graph.microsoft.com',
  makeClient: () => microsoftBookings({ accessToken: 'token', businessId: BIZ }),
  errorProbe: { method: 'GET', path: APPTS, run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps staff + service',
      method: 'POST',
      path: APPTS,
      reply: APPT,
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          serviceId: 'svc1',
          staffId: 'staff1',
          customer: { name: 'Jane', email: 'jane@example.com' },
        }),
      check: (b) => {
        expect(b.staffId).toBe('staff1');
        expect(b.serviceId).toBe('svc1');
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
      },
    },
    {
      name: 'getBooking',
      method: 'GET',
      path: APPTS,
      reply: APPT,
      run: (c) => c.getBooking('a1'),
    },
    {
      name: 'updateBooking reschedules',
      method: 'PATCH',
      path: APPTS,
      reply: APPT,
      run: (c) => c.updateBooking('a1', { range: RANGE }),
    },
    {
      name: 'cancelBooking posts /cancel',
      method: 'POST',
      path: `${APPTS}/a1/cancel`,
      reply: '',
      run: (c) => c.cancelBooking('a1', { reason: 'client asked' }),
    },
    {
      name: 'listBookings via calendarView',
      method: 'GET',
      path: VIEW,
      reply: { value: [APPT] },
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
  ],
});
