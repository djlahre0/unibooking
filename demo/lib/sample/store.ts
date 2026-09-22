import { buildSeed } from './seed';
import { todayIn } from '../calendar/agenda';
import type { SampleData } from './types';

export const SAMPLE_KEY = 'unibooking:demo:sample:v1';

/**
 * Used when storage is unavailable (private mode, blocked cookies) or throws.
 * The demo then still works for the session; it just does not survive a reload.
 *
 * Scoped to the Storage it came from (by reference, including the `null` case
 * for "no storage available"): without that, this being module-level state
 * means a second, unrelated Storage instance would silently inherit the first
 * one's data instead of seeding its own, and never get written to at all.
 */
let memory: { store: Storage | null; data: SampleData } | null = null;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Accessing localStorage itself throws when site data is blocked.
    return null;
  }
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A service and a staff member share this shape: an id, a name, and an active flag. */
function isServiceOrStaffShape(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.active === 'boolean'
  );
}

function isCustomerShape(v: unknown): boolean {
  return isRecord(v) && typeof v.id === 'string';
}

function isBookingShape(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.status === 'string' &&
    isRecord(v.range) &&
    typeof v.range.start === 'string' &&
    typeof v.range.end === 'string'
  );
}

/**
 * Shape guard: a corrupt or older payload is discarded rather than trusted.
 * Checked one level into each collection, not just that it is an array — a
 * bare `{}` inside `bookings` would otherwise sail through and reach the UI.
 */
function isSampleData(value: unknown): value is SampleData {
  if (!isRecord(value)) return false;
  const d = value as Partial<SampleData>;
  return (
    d.version === 1 &&
    typeof d.seededAt === 'string' &&
    typeof d.timezone === 'string' &&
    typeof d.nextId === 'number' &&
    Array.isArray(d.services) &&
    d.services.every(isServiceOrStaffShape) &&
    Array.isArray(d.staff) &&
    d.staff.every(isServiceOrStaffShape) &&
    Array.isArray(d.customers) &&
    d.customers.every(isCustomerShape) &&
    Array.isArray(d.bookings) &&
    d.bookings.every(isBookingShape)
  );
}

export function loadSample(storage?: Storage): SampleData {
  const store = storage ?? defaultStorage();
  if (store) {
    try {
      const raw = store.getItem(SAMPLE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isSampleData(parsed)) return parsed;
      }
    } catch {
      // Corrupt JSON or a throwing storage: fall through and re-seed.
    }
  }
  // Only trust the fallback if IT was produced by this same storage (by
  // reference) — otherwise an unrelated Storage instance would inherit
  // whatever another one last held, and never get its own write.
  if (memory && memory.store === store) return memory.data;
  const tz = browserZone();
  const seeded = buildSeed(todayIn(tz), tz);
  saveSample(seeded, storage);
  return seeded;
}

export function saveSample(data: SampleData, storage?: Storage): void {
  const store = storage ?? defaultStorage();
  memory = { store, data };
  try {
    store?.setItem(SAMPLE_KEY, JSON.stringify(data));
  } catch {
    // Quota or blocked storage: `memory` already holds it, scoped to this
    // same storage, so it degrades to in-memory-only rather than leaking.
  }
}

export function resetSample(today?: string, timezone?: string, storage?: Storage): SampleData {
  const tz = timezone ?? browserZone();
  const seeded = buildSeed(today ?? todayIn(tz), tz);
  memory = null;
  saveSample(seeded, storage);
  return seeded;
}
