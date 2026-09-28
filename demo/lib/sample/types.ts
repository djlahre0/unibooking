import type { Booking, Customer, ProviderId, Service, Staff } from 'unibooking';

/**
 * 'sample' is deliberately NOT a published ProviderId: this client exists only
 * in the explorer and must never widen the library's public API. One cast here
 * keeps the fake contained; nothing else in the demo re-casts it.
 */
export const SAMPLE_ID = 'sample' as unknown as ProviderId;

/** A customer that has been through findOrCreate, so it always has an id. */
export type SampleCustomer = Customer & { id: string; note?: string };

export interface SampleData {
  version: 1;
  /** YYYY-MM-DD the seed was anchored to. "Reset" re-anchors to today. */
  seededAt: string;
  /** IANA zone the business trades in; every instant is built in this zone. */
  timezone: string;
  services: Service[];
  staff: Staff[];
  customers: SampleCustomer[];
  bookings: Booking[];
  /** Monotonic, so an id is never reused after a cancel. */
  nextId: number;
}
