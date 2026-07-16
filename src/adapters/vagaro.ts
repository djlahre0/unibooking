import type { AvailabilitySlot, Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import { assertValidRange, endFromDuration } from '../time';

/**
 * Vagaro Enterprise Business API V2. The public API is **read + webhooks only** —
 * the vendor confirms there is no appointment create/update/cancel/list endpoint, so
 * those methods throw UNSUPPORTED. Bring your own OAuth2 bearer token (use the
 * function credential form for refresh). `region` is a per-business path segment.
 */
export type VagaroCredentials = {
  region: string;
  accessToken: string;
};

const BASE = 'https://api.vagaro.com/';

function enc(id: string): string {
  return encodeURIComponent(id);
}

function merchantPath(c: VagaroCredentials, sub: string): string {
  return `${enc(c.region)}/api/v2/merchants/${sub}`;
}

function mapStatus(s: unknown): BookingStatus {
  switch (s) {
    case 'Confirmed':
    case 'Accepted':
    case 'Ready to Start':
    case 'Service In Progress':
      return 'confirmed';
    case 'Awaiting Confirmation':
    case 'Need Acceptance':
      return 'pending';
    case 'Denied':
      return 'declined';
    case 'Cancel':
    case 'Deleted':
      return 'cancelled';
    case 'No Show':
      return 'no_show';
    case 'Service Completed':
    case 'Show':
      return 'completed';
    default:
      return 'unknown';
  }
}

function parseVagaroError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const b = body as any;
  if (!b || typeof b !== 'object') return {};
  const message = typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : undefined;
  const code = b.errorCode ?? b.code;
  return {
    ...(message ? { message } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { providerCode: String(code) } : {}),
  };
}

function toBooking(raw: unknown): Booking {
  const a = asRecord(raw, 'vagaro', 'appointment');
  const start = reqString(a.startTime, 'vagaro', 'appointment.startTime');
  const end = reqString(a.endTime, 'vagaro', 'appointment.endTime');
  return {
    id: reqString(String(a.appointmentId ?? ''), 'vagaro', 'appointment.appointmentId'),
    provider: 'vagaro',
    title: typeof a.serviceTitle === 'string' && a.serviceTitle ? a.serviceTitle : 'Appointment',
    range: { start, end },
    ...(a.serviceProviderId ? { staffId: String(a.serviceProviderId) } : {}),
    ...(a.serviceId ? { serviceId: String(a.serviceId) } : {}),
    ...(a.customerId ? { customer: { id: String(a.customerId) } } : {}),
    status: mapStatus(a.bookingStatus),
    ...(typeof a.createdDate === 'string' ? { createdAt: a.createdDate } : {}),
    ...(typeof a.modifiedDate === 'string' ? { updatedAt: a.modifiedDate } : {}),
    raw: a,
  };
}

export const vagaro = defineAdapter<VagaroCredentials>({
  id: 'vagaro',
  capabilities: {
    availability: true,
    staff: false,
    services: false,
    webhooks: true,
    idempotency: false,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  parseError: parseVagaroError,
  build: (http) => ({
    createBooking: async () =>
      unsupported('vagaro', 'createBooking (Vagaro API has no appointment-create endpoint)'),

    async getBooking(id) {
      const c = await http.resolve();
      const res = await http.request(c, { path: merchantPath(c, `appointments/${enc(id)}`) });
      return toBooking(res);
    },

    updateBooking: async () =>
      unsupported('vagaro', 'updateBooking (Vagaro API has no appointment-update endpoint)'),

    cancelBooking: async () =>
      unsupported('vagaro', 'cancelBooking (cancellations arrive via webhook, not the API)'),

    listBookings: async () =>
      unsupported('vagaro', 'listBookings (no list endpoint; changes are delivered via webhooks)'),

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'vagaro');
      const c = await http.resolve();
      // TODO: verify path/params against the live API — the availability endpoint
      // shape is not fully documented publicly.
      const res = await http.request(c, {
        path: merchantPath(c, 'appointments/availability'),
        query: {
          startTime: query.range.start,
          endTime: query.range.end,
          serviceId: query.serviceId,
          serviceProviderId: query.staffId,
        },
      });
      const slots = asArray(res, 'vagaro', 'availability');
      return slots.flatMap((s: any) => {
        if (typeof s.startTime !== 'string') return [];
        // Prefer the provider's endTime; else size from durationMinutes. Skip a
        // slot we can't size rather than emit a zero-length (end === start) range.
        const end =
          typeof s.endTime === 'string'
            ? s.endTime
            : typeof query.durationMinutes === 'number' && query.durationMinutes > 0
              ? endFromDuration(s.startTime, query.durationMinutes)
              : undefined;
        if (end === undefined) return [];
        return [{ start: s.startTime, end, raw: s }];
      });
    },
  }),
});
