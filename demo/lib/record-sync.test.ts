import { describe, it, expect } from 'vitest';
import type { Staff } from 'unibooking';
import type { Call } from './call-type';
import {
  addRecord,
  editRecord,
  importRecord,
  linkRecord,
  loadRecords,
  saveRecords,
  statusOf,
  syncRecords,
  unlinkRecord,
  type SyncOptions,
} from './record-sync';

/** A provider's staff directory in memory, behind the `Call` contract. */
function provider(initial: Staff[], opts: { failUpdate?: boolean } = {}) {
  const staff = initial.map((m) => ({ ...m }));
  let next = 100;
  const calls: string[] = [];
  const call: Call = async (_p, _c, op, args) => {
    calls.push(op);
    switch (op) {
      case 'listStaff':
        return { ok: true, data: { staff: staff.map((m) => ({ ...m })) } };
      case 'createStaff': {
        const m = {
          id: `tm_${next++}`,
          name: String(args.name),
          ...(args.email ? { email: String(args.email) } : {}),
          active: true,
          raw: {},
        } as Staff;
        staff.push(m);
        return { ok: true, data: m };
      }
      case 'updateStaff': {
        if (opts.failUpdate) return { ok: false, error: { message: 'nope' } };
        const m = staff.find((x) => x.id === args.id)!;
        Object.assign(m, {
          name: args.name,
          ...(args.email ? { email: args.email } : {}),
        });
        return { ok: true, data: { ...m } };
      }
      default:
        return { ok: false, error: { message: `unexpected ${op}` } };
    }
  };
  return { staff, call, calls };
}

const ANA: Staff = { id: 'tm_1', name: 'Ana Silva', email: 'ana@x.com', active: true, raw: {} };
const BO: Staff = { id: 'tm_2', name: 'Bo Li', email: 'bo@x.com', active: true, raw: {} };

let clock = 0;
const opts = (call: Call, over: Partial<SyncOptions> = {}): SyncOptions => ({
  provider: 'square',
  conn: { creds: {} },
  kind: 'staff',
  call,
  canWrite: true,
  autoMatch: true,
  importUnmatched: true,
  createMissingAtProvider: false,
  now: () => `2026-09-25T00:00:${String(clock++).padStart(2, '0')}Z`,
  ...over,
});

describe('syncRecords: import and link', () => {
  it('imports provider records once and never duplicates on re-run', async () => {
    const p = provider([ANA, BO]);
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    expect(first.report).toMatchObject({ imported: 2, errors: [] });
    expect(first.data.records.map((r) => r.links.square?.providerId)).toEqual(['tm_1', 'tm_2']);

    const again = await syncRecords(first.data, opts(p.call));
    expect(again.report).toMatchObject({ imported: 0, unchanged: 2 });
    expect(again.data.records).toHaveLength(2);
  });

  it('links to an existing UniBooking record by email instead of importing a copy', async () => {
    const p = provider([ANA]);
    const mine = addRecord({ records: [], nextId: 1 }, 'staff', {
      name: 'Ana S.',
      email: 'ANA@x.com',
    });
    const r = await syncRecords(mine, opts(p.call));
    expect(r.report).toMatchObject({ linked: 1, imported: 0 });
    // The provider owns the record, so its values are taken.
    expect(r.data.records[0]).toMatchObject({ id: 'ub_1', name: 'Ana Silva' });
  });
});

describe('syncRecords: the two sides are never merged by default', () => {
  it('without import, unmatched provider records stay on the provider side', async () => {
    const p = provider([ANA, BO]);
    const mine = addRecord({ records: [], nextId: 1 }, 'staff', { name: 'Ana', email: 'ana@x.com' });
    const r = await syncRecords(mine, opts(p.call, { importUnmatched: false }));
    expect(r.report).toMatchObject({ linked: 1, imported: 0, unlinked: 1 });
    expect(r.data.records).toHaveLength(1);
  });

  it('without auto-match, nothing is linked automatically', async () => {
    const p = provider([ANA]);
    const mine = addRecord({ records: [], nextId: 1 }, 'staff', { name: 'Ana', email: 'ana@x.com' });
    const r = await syncRecords(mine, opts(p.call, { autoMatch: false, importUnmatched: false }));
    expect(r.report).toMatchObject({ linked: 0, unlinked: 1 });
    expect(statusOf(r.data.records[0]!, 'square')).toBe('local-only');
  });

  it('importRecord copies one provider record in, linked', () => {
    const d = importRecord({ records: [], nextId: 1 }, 'staff', 'square', BO);
    expect(d.records[0]).toMatchObject({ id: 'ub_1', name: 'Bo Li' });
    expect(statusOf(d.records[0]!, 'square')).toBe('linked');
  });
});

describe('syncRecords: changes both ways', () => {
  it('pulls a provider change', async () => {
    const p = provider([ANA]);
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    p.staff[0]!.name = 'Ana Costa';
    const r = await syncRecords(first.data, opts(p.call));
    expect(r.report.pulled).toBe(1);
    expect(r.data.records[0]!.name).toBe('Ana Costa');
  });

  it('pushes a UniBooking change where the provider accepts writes', async () => {
    const p = provider([ANA]);
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    const edited = editRecord(first.data, 'ub_1', { name: 'Ana Maria Silva' });
    expect(statusOf(edited.records[0]!, 'square')).toBe('changed');
    const r = await syncRecords(edited, opts(p.call));
    expect(r.report.pushed).toBe(1);
    expect(p.staff[0]!.name).toBe('Ana Maria Silva');
    expect(statusOf(r.data.records[0]!, 'square')).toBe('linked');
  });

  it('keeps a UniBooking change local when the provider is read-only', async () => {
    const p = provider([ANA]);
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    const edited = editRecord(first.data, 'ub_1', { name: 'Ana M.' });
    const r = await syncRecords(edited, opts(p.call, { canWrite: false }));
    expect(r.report.heldLocally).toBe(1);
    expect(p.calls).not.toContain('updateStaff');
  });

  it('on a conflict the provider wins, and it is reported', async () => {
    const p = provider([ANA]);
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    const edited = editRecord(first.data, 'ub_1', { name: 'Local name' });
    p.staff[0]!.name = 'Provider name';
    const r = await syncRecords(edited, opts(p.call));
    expect(r.report.conflicts).toBe(1);
    expect(r.data.records[0]!.name).toBe('Provider name');
    expect(p.calls).not.toContain('updateStaff');
  });

  it('a failed push is reported and nothing else stops', async () => {
    const p = provider([ANA, BO], { failUpdate: true });
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    const edited = editRecord(first.data, 'ub_1', { name: 'X' });
    const r = await syncRecords(edited, opts(p.call));
    expect(r.report.errors).toEqual([{ name: 'X', message: 'nope' }]);
    expect(r.report.unchanged).toBe(1);
  });
});

describe('syncRecords: removed and missing records', () => {
  it('marks a record gone from the provider as removed and keeps it', async () => {
    const p = provider([ANA, BO]);
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    p.staff.splice(1, 1);
    const r = await syncRecords(first.data, opts(p.call));
    expect(r.report.removed).toBe(1);
    expect(r.data.records).toHaveLength(2);
    expect(statusOf(r.data.records[1]!, 'square')).toBe('removed');
  });

  it('creates UniBooking-only records at the provider only when asked', async () => {
    const p = provider([]);
    const mine = addRecord({ records: [], nextId: 1 }, 'staff', { name: 'Remy', email: 'r@x.com' });
    const off = await syncRecords(mine, opts(p.call));
    expect(off.report.created).toBe(0);
    expect(statusOf(off.data.records[0]!, 'square')).toBe('local-only');

    const on = await syncRecords(mine, opts(p.call, { createMissingAtProvider: true }));
    expect(on.report.created).toBe(1);
    expect(on.data.records[0]!.links.square?.providerId).toBe('tm_100');
    // And the next sync sees it as linked, not as a new provider record.
    const again = await syncRecords(on.data, opts(p.call));
    expect(again.report).toMatchObject({ imported: 0, unchanged: 1 });
  });
});

describe('manual mapping', () => {
  it('remapping moves the link, so one provider record never maps to two', async () => {
    const p = provider([ANA]);
    const first = await syncRecords({ records: [], nextId: 1 }, opts(p.call));
    const withOther = addRecord(first.data, 'staff', { name: 'Ana (old)' });
    const remapped = linkRecord(withOther, 'ub_2', 'square', ANA);
    expect(remapped.records[0]!.links.square).toBeUndefined();
    expect(remapped.records[1]!.links.square?.providerId).toBe('tm_1');
    const unlinked = unlinkRecord(remapped, 'ub_2', 'square');
    expect(statusOf(unlinked.records[1]!, 'square')).toBe('local-only');
  });

  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;
    const data = addRecord({ records: [], nextId: 1 }, 'services', { name: 'Cut' });
    saveRecords(data, storage);
    expect(loadRecords(storage)).toEqual(data);
  });
});
