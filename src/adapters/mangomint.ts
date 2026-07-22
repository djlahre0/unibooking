import { defineAdapter, unsupported } from '../adapter-kit';

/**
 * Mangomint — NOT YET IMPLEMENTED. Mangomint has no public API documentation; the
 * API host is live but every detail (auth, paths, fields, status enum, errors) is
 * gated behind sales/support, so a correct adapter can't be built from public sources.
 */
export type MangomintCredentials = {
  apiKey: string;
};

const NOT_IMPL = 'not yet implemented — Mangomint publishes no public API documentation';

export const mangomint = defineAdapter<MangomintCredentials>({
  id: 'mangomint',
  capabilities: {
    availability: false,
    staff: false,
    services: false,
    webhooks: false,
    idempotency: false,
    customers: false,
  },
  baseUrl: 'https://api.mangomint.com/',
  auth: () => ({}),
  build: () => ({
    createBooking: async () => unsupported('mangomint', `createBooking (${NOT_IMPL})`),
    getBooking: async () => unsupported('mangomint', `getBooking (${NOT_IMPL})`),
    updateBooking: async () => unsupported('mangomint', `updateBooking (${NOT_IMPL})`),
    cancelBooking: async () => unsupported('mangomint', `cancelBooking (${NOT_IMPL})`),
    listBookings: async () => unsupported('mangomint', `listBookings (${NOT_IMPL})`),
    searchAvailability: async () => unsupported('mangomint', `searchAvailability (${NOT_IMPL})`),
  }),
});
