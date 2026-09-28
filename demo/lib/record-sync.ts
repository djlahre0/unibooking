import type { Money, Service, Staff } from 'unibooking';
import type { Call } from './call-type';
import type { Connection } from './result';

/**
 * Staff & service mapping: link a provider's records to UniBooking's own, and
 * keep them in step.
 *
 * The PROVIDER owns the data. UniBooking keeps its own record of each staff
 * member and service and links it to the provider's by the provider's stable
 * id. A sync:
 *
 * 1. reads every provider record;
 * 2. for each linked pair, pulls provider changes; pushes UniBooking changes
 *    only where the provider accepts writes; on a conflict (both changed since
 *    the last sync) the provider wins and the conflict is reported;
 * 3. marks a link whose provider record has gone as `removed` -- it never
 *    deletes the UniBooking record;
 * 4. links each unlinked provider record to an unlinked UniBooking record that
 *    matches (staff by email, services by name), or imports it as a new one --
 *    so re-running never duplicates;
 * 5. optionally creates UniBooking-only records at the provider.
 *
 * In this demo "UniBooking" is a store in the browser standing in for the
 * platform's database. Everything talks to providers through an injected
 * `call`, so the whole flow is testable without a network.
 */

export type Kind = 'staff' | 'services';

/** How a UniBooking record is tied to one provider's record. */
export type Link = {
  providerId: string;
  syncedAt: string;
  /** Fingerprints of both sides at the last sync: what "changed since" means. */
  localHash: string;
  remoteHash: string;
  /** The provider record was not found at the last sync. */
  removed?: boolean;
};

export type UbRecord = {
  id: string;
  kind: Kind;
  name: string;
  email?: string;
  phone?: string;
  durationMinutes?: number;
  price?: Money;
  active: boolean;
  /** provider id (e.g. 'square') -> its link. */
  links: Record<string, Link>;
};

/* ── Store ────────────────────────────────────────────────────────────── */

export const RECORDS_KEY = 'unibooking:demo:records:v1';

type Stored = { records: UbRecord[]; nextId: number };

export function loadRecords(storage?: Storage): Stored {
  try {
    const raw = (storage ?? localStorage).getItem(RECORDS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.records) && typeof parsed.nextId === 'number') {
      return parsed as Stored;
    }
  } catch {
    // Blocked or corrupt storage: start empty rather than crash.
  }
  return { records: [], nextId: 1 };
}

export function saveRecords(data: Stored, storage?: Storage): void {
  try {
    (storage ?? localStorage).setItem(RECORDS_KEY, JSON.stringify(data));
  } catch {
    // Quota or blocked storage: the mapping just won't survive a reload.
  }
}

export function clearRecords(storage?: Storage): void {
  try {
    (storage ?? localStorage).removeItem(RECORDS_KEY);
  } catch {
    // Nothing saved to clear.
  }
}

/* ── Fields, fingerprints, matching ───────────────────────────────────── */

type Fields = Pick<UbRecord, 'name' | 'email' | 'phone' | 'durationMinutes' | 'price' | 'active'>;

/** The fields a kind carries, from a provider record. */
export function fieldsOf(kind: Kind, r: Staff | Service): Fields {
  if (kind === 'staff') {
    const m = r as Staff;
    return {
      name: m.name,
      active: m.active,
      ...(m.email ? { email: m.email } : {}),
      ...(m.phone ? { phone: m.phone } : {}),
    };
  }
  const s = r as Service;
  return {
    name: s.name,
    active: s.active,
    ...(s.durationMinutes !== undefined ? { durationMinutes: s.durationMinutes } : {}),
    ...(s.price ? { price: s.price } : {}),
  };
}

/** Order-stable fingerprint of the synced fields. */
export function hashOf(f: Partial<Fields>): string {
  return JSON.stringify([
    f.name?.trim() ?? '',
    f.email?.trim().toLowerCase() ?? '',
    f.phone?.trim() ?? '',
    f.durationMinutes ?? null,
    f.price ? [f.price.amount, f.price.currency] : null,
    f.active ?? true,
  ]);
}

/** What identifies "the same" record across systems: email for a person,
 *  name for a service. Undefined means it cannot be matched automatically. */
export function matchKey(kind: Kind, f: Partial<Fields>): string | undefined {
  if (kind === 'staff') return f.email?.trim().toLowerCase() || undefined;
  return f.name?.trim().toLowerCase() || undefined;
}

/** The body a push sends: dispatch.ts's catalog form fields. */
function pushFields(kind: Kind, r: UbRecord): Record<string, string> {
  if (kind === 'staff') {
    return {
      name: r.name,
      ...(r.email ? { email: r.email } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
    };
  }
  return {
    name: r.name,
    ...(r.durationMinutes !== undefined ? { durationMinutes: String(r.durationMinutes) } : {}),
    ...(r.price
      ? { price: (r.price.amount / 100).toFixed(2), currency: r.price.currency }
      : {}),
  };
}

/* ── Sync ─────────────────────────────────────────────────────────────── */

export type SyncOptions = {
  provider: string;
  conn: Connection;
  kind: Kind;
  call: Call;
  /** The provider accepts writes for this kind (serviceCatalogWrite /
   *  staffDirectoryWrite). Without it UniBooking changes stay local. */
  canWrite: boolean;
  /** Link unlinked provider records to an unlinked project record that
   *  matches (staff by email, services by name). Only ever links. */
  autoMatch: boolean;
  /** Copy provider records that match nothing into the project as new
   *  records. Off unless the user asks: the two sides are never merged. */
  importUnmatched: boolean;
  /** Create project-only records at the provider (needs canWrite). */
  createMissingAtProvider: boolean;
  now?: () => string;
};

export type RecordSyncReport = {
  imported: number;
  linked: number;
  pulled: number;
  pushed: number;
  created: number;
  unchanged: number;
  conflicts: number;
  removed: number;
  /** UniBooking changes that could not be pushed (provider is read-only). */
  heldLocally: number;
  /** Provider records left unlinked (no match, not imported). */
  unlinked: number;
  errors: { name: string; message: string }[];
  log: string[];
};

async function listRemote(
  call: Call,
  provider: string,
  conn: Connection,
  kind: Kind,
): Promise<{ items: (Staff | Service)[]; complete: boolean }> {
  const out: (Staff | Service)[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await call(provider, conn, kind === 'staff' ? 'listStaff' : 'listServices', {
      limit: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    if (!r.ok) throw new Error(r.error?.message ?? 'list failed');
    const d = r.data as { staff?: Staff[]; services?: Service[]; nextPageToken?: string };
    out.push(...((kind === 'staff' ? d.staff : d.services) ?? []));
    pageToken = d.nextPageToken;
    if (!pageToken) return { items: out, complete: true };
  }
  return { items: out, complete: false };
}

export async function syncRecords(
  data: Stored,
  opts: SyncOptions,
): Promise<{ data: Stored; report: RecordSyncReport }> {
  const { provider, conn, kind, call } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const next: Stored = {
    nextId: data.nextId,
    records: data.records.map((r) => ({ ...r, links: { ...r.links } })),
  };
  const report: RecordSyncReport = {
    imported: 0,
    linked: 0,
    pulled: 0,
    pushed: 0,
    created: 0,
    unchanged: 0,
    conflicts: 0,
    removed: 0,
    heldLocally: 0,
    unlinked: 0,
    errors: [],
    log: [],
  };
  const mine = next.records.filter((r) => r.kind === kind);
  const listed = await listRemote(call, provider, conn, kind);
  const remote = listed.items;
  const byId = new Map(remote.map((x) => [x.id, x]));
  const linkedIds = new Set<string>();

  const setLink = (r: UbRecord, providerId: string, remoteHash: string) => {
    r.links[provider] = { providerId, syncedAt: now(), localHash: hashOf(r), remoteHash };
    linkedIds.add(providerId);
  };
  const pull = (r: UbRecord, x: Staff | Service) => {
    const f = fieldsOf(kind, x);
    r.name = f.name;
    r.active = f.active;
    if (kind === 'staff') {
      r.email = f.email;
      r.phone = f.phone;
    } else {
      r.durationMinutes = f.durationMinutes;
      r.price = f.price;
    }
  };
  const push = async (r: UbRecord, providerId: string): Promise<Staff | Service> => {
    const res = await call(provider, conn, kind === 'staff' ? 'updateStaff' : 'updateService', {
      ...pushFields(kind, r),
      id: providerId,
    });
    if (!res.ok) throw new Error(res.error?.message ?? 'update failed');
    return res.data as Staff | Service;
  };

  // 1–3: every UniBooking record already linked to this provider.
  for (const r of mine) {
    const link = r.links[provider];
    if (!link) continue;
    const x = byId.get(link.providerId);
    if (!x) {
      // Absent from a list cut off at the page cap proves nothing.
      if (!listed.complete) continue;
      if (!link.removed) {
        r.links[provider] = { ...link, removed: true };
        report.removed++;
        report.log.push(`${r.name}: no longer at ${provider}; kept in UniBooking, marked removed.`);
      }
      continue;
    }
    linkedIds.add(x.id);
    const remoteHash = hashOf(fieldsOf(kind, x));
    const localChanged = hashOf(r) !== link.localHash;
    const remoteChanged = remoteHash !== link.remoteHash || link.removed === true;
    try {
      if (remoteChanged) {
        if (localChanged) {
          report.conflicts++;
          report.log.push(`${r.name}: changed on both sides; ${provider} wins (it owns the record).`);
        }
        pull(r, x);
        setLink(r, x.id, remoteHash);
        report.pulled++;
      } else if (localChanged) {
        if (opts.canWrite) {
          const saved = await push(r, x.id);
          setLink(r, x.id, hashOf(fieldsOf(kind, saved)));
          report.pushed++;
          report.log.push(`${r.name}: UniBooking changes sent to ${provider}.`);
        } else {
          report.heldLocally++;
        }
      } else {
        report.unchanged++;
      }
    } catch (e) {
      report.errors.push({ name: r.name, message: (e as Error).message });
    }
  }

  // 4: provider records nobody links to yet: match (if asked), import (if
  // asked), otherwise leave them unlinked on the provider side.
  const unlinkedLocal = new Map<string, UbRecord>();
  for (const r of mine) {
    const key = matchKey(kind, r);
    if (!r.links[provider] && key && !unlinkedLocal.has(key)) unlinkedLocal.set(key, r);
  }
  for (const x of remote) {
    if (linkedIds.has(x.id)) continue;
    const f = fieldsOf(kind, x);
    const key = matchKey(kind, f);
    const match = opts.autoMatch && key ? unlinkedLocal.get(key) : undefined;
    if (match) {
      unlinkedLocal.delete(key!);
      pull(match, x);
      setLink(match, x.id, hashOf(f));
      report.linked++;
      report.log.push(`${f.name}: matched an existing UniBooking record and linked it.`);
    } else if (opts.importUnmatched) {
      const r: UbRecord = { id: `ub_${next.nextId++}`, kind, ...f, links: {} };
      setLink(r, x.id, hashOf(f));
      next.records.push(r);
      report.imported++;
    } else {
      report.unlinked++;
    }
  }

  // 5: UniBooking-only records, created at the provider when asked.
  if (opts.createMissingAtProvider && opts.canWrite) {
    for (const r of next.records) {
      if (r.kind !== kind || r.links[provider]) continue;
      try {
        const res = await call(provider, conn, kind === 'staff' ? 'createStaff' : 'createService', {
          ...pushFields(kind, r),
        });
        if (!res.ok) throw new Error(res.error?.message ?? 'create failed');
        const x = res.data as Staff | Service;
        setLink(r, x.id, hashOf(fieldsOf(kind, x)));
        report.created++;
        report.log.push(`${r.name}: created at ${provider} and linked.`);
      } catch (e) {
        report.errors.push({ name: r.name, message: (e as Error).message });
      }
    }
  }
  return { data: next, report };
}

/* ── Manual mapping ───────────────────────────────────────────────────── */

/** Link (or re-link) a UniBooking record to a specific provider record. Any
 *  other UniBooking record linked to that provider record is unlinked, so one
 *  provider record never maps to two. Provider values are taken as-is. */
export function linkRecord(
  data: Stored,
  recordId: string,
  provider: string,
  remote: Staff | Service,
  now = () => new Date().toISOString(),
): Stored {
  const records = data.records.map((r) => {
    const copy = { ...r, links: { ...r.links } };
    if (copy.id !== recordId && copy.links[provider]?.providerId === remote.id) {
      delete copy.links[provider];
    }
    if (copy.id === recordId) {
      const f = fieldsOf(copy.kind, remote);
      Object.assign(copy, f);
      copy.links[provider] = {
        providerId: remote.id,
        syncedAt: now(),
        localHash: hashOf(copy),
        remoteHash: hashOf(f),
      };
    }
    return copy;
  });
  return { ...data, records };
}

/** Copy one provider record into the project as a new, linked record. */
export function importRecord(
  data: Stored,
  kind: Kind,
  provider: string,
  remote: Staff | Service,
  now = () => new Date().toISOString(),
): Stored {
  const f = fieldsOf(kind, remote);
  const r: UbRecord = { id: `ub_${data.nextId}`, kind, ...f, links: {} };
  r.links[provider] = {
    providerId: remote.id,
    syncedAt: now(),
    localHash: hashOf(r),
    remoteHash: hashOf(f),
  };
  return { nextId: data.nextId + 1, records: [...data.records, r] };
}

export function unlinkRecord(data: Stored, recordId: string, provider: string): Stored {
  return {
    ...data,
    records: data.records.map((r) => {
      if (r.id !== recordId || !r.links[provider]) return r;
      const links = { ...r.links };
      delete links[provider];
      return { ...r, links };
    }),
  };
}

/** A UniBooking-only record, e.g. to show pushing one to the provider. */
export function addRecord(data: Stored, kind: Kind, fields: Partial<Fields> & { name: string }): Stored {
  return {
    nextId: data.nextId + 1,
    records: [
      ...data.records,
      { id: `ub_${data.nextId}`, kind, active: true, ...fields, links: {} },
    ],
  };
}

export function editRecord(data: Stored, recordId: string, fields: Partial<Fields>): Stored {
  return {
    ...data,
    records: data.records.map((r) => (r.id === recordId ? { ...r, ...fields } : r)),
  };
}

/** Where a record stands with one provider, for the status column. */
export type LinkStatus = 'linked' | 'changed' | 'removed' | 'local-only';

export function statusOf(r: UbRecord, provider: string): LinkStatus {
  const link = r.links[provider];
  if (!link) return 'local-only';
  if (link.removed) return 'removed';
  return hashOf(r) === link.localHash ? 'linked' : 'changed';
}
