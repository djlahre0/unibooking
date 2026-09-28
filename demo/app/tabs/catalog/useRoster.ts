'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities, Service, Staff } from 'unibooking';
import {
  type ActionResult,
  type Connection,
  callListServices,
  callListStaff,
} from '../../../lib/call';
import { isLocal } from '../../../lib/providers';

/**
 * The services and staff of one provider, held for the Services and Staff
 * tabs. Both tabs need both lists: a service row shows who performs it, a
 * staff row shows what they perform.
 *
 * Every call goes through page.tsx's `wrap`, so the busy state, the timing and
 * the "last call" result box behave exactly as on every other tab.
 */
export type Roster = {
  services: Service[];
  staff: Staff[];
  /** True once a load has finished (even an empty or failed one). */
  loaded: boolean;
  /** More pages exist beyond what is shown. */
  moreServices: boolean;
  moreStaff: boolean;
  /** A problem loading the list this tab is NOT about (shown quietly). */
  sideProblem: string;
  load: () => Promise<void>;
  loadMore: (which: 'services' | 'staff') => Promise<void>;
  /** Run one call; on success hand its data to `onOk`. */
  act: (fn: () => Promise<ActionResult>, onOk?: (data: unknown) => void) => Promise<void>;
  upsertService: (s: Service) => void;
  upsertStaff: (m: Staff) => void;
  dropService: (id: string) => void;
  dropStaff: (id: string) => void;
};

export type Wrap = (
  section: string,
  fn: () => Promise<ActionResult>,
  setter: (r: ActionResult) => void,
) => Promise<void>;

const PAGE = 100;

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const at = list.findIndex((x) => x.id === item.id);
  if (at === -1) return [item, ...list];
  const next = list.slice();
  next[at] = item;
  return next;
}

export function useRoster(opts: {
  provider: string;
  conn: Connection;
  caps: Capabilities | null;
  /** Which list this tab is about; its result is the one shown. */
  primary: 'services' | 'staff';
  section: string;
  wrap: Wrap;
  setResult: (r: ActionResult | null) => void;
}): Roster {
  const { provider, conn, caps, primary, section, wrap, setResult } = opts;
  const [services, setServices] = useState<Service[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [svcToken, setSvcToken] = useState<string>();
  const [stfToken, setStfToken] = useState<string>();
  const [sideProblem, setSideProblem] = useState('');

  const canServices = !!caps?.serviceCatalog;
  const canStaff = !!caps?.staffDirectory;

  const act = useCallback<Roster['act']>(
    (fn, onOk) =>
      wrap(section, fn, (r) => {
        setResult(r);
        if (r.ok) onOk?.(r.data);
      }),
    [wrap, section, setResult],
  );

  const load = useCallback(async () => {
    await wrap(
      section,
      async () => {
        const [sv, st] = await Promise.all([
          canServices ? callListServices(provider, conn, { limit: PAGE }) : null,
          canStaff ? callListStaff(provider, conn, { limit: PAGE }) : null,
        ]);
        if (sv?.ok) {
          const d = sv.data as { services: Service[]; nextPageToken?: string };
          setServices(d.services);
          setSvcToken(d.nextPageToken);
        }
        if (st?.ok) {
          const d = st.data as { staff: Staff[]; nextPageToken?: string };
          setStaff(d.staff);
          setStfToken(d.nextPageToken);
        }
        const side = primary === 'services' ? st : sv;
        setSideProblem(side && !side.ok ? (side.error?.message ?? 'failed') : '');
        setLoaded(true);
        const main = primary === 'services' ? sv : st;
        return main ?? { ok: false, error: { code: 'UNSUPPORTED', message: 'Not supported.' } };
      },
      setResult,
    );
  }, [wrap, section, setResult, provider, conn, canServices, canStaff, primary]);

  const loadMore = useCallback<Roster['loadMore']>(
    async (which) => {
      if (which === 'services' && svcToken) {
        await act(
          () => callListServices(provider, conn, { limit: PAGE, pageToken: svcToken }),
          (data) => {
            const d = data as { services: Service[]; nextPageToken?: string };
            setServices((prev) => [...prev, ...d.services.filter((s) => !prev.some((p) => p.id === s.id))]);
            setSvcToken(d.nextPageToken);
          },
        );
      } else if (which === 'staff' && stfToken) {
        await act(
          () => callListStaff(provider, conn, { limit: PAGE, pageToken: stfToken }),
          (data) => {
            const d = data as { staff: Staff[]; nextPageToken?: string };
            setStaff((prev) => [...prev, ...d.staff.filter((s) => !prev.some((p) => p.id === s.id))]);
            setStfToken(d.nextPageToken);
          },
        );
      }
    },
    [act, provider, conn, svcToken, stfToken],
  );

  // The sample lives in this browser, so opening the tab can just show it.
  // A real account is only read when the visitor asks: the lists are live API
  // calls against their business.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current || !isLocal(provider) || !(canServices || canStaff)) return;
    autoLoaded.current = true;
    void load();
  }, [provider, canServices, canStaff, load]);

  return {
    services,
    staff,
    loaded,
    moreServices: !!svcToken,
    moreStaff: !!stfToken,
    sideProblem,
    load,
    loadMore,
    act,
    upsertService: useCallback((s: Service) => setServices((l) => upsert(l, s)), []),
    upsertStaff: useCallback((m: Staff) => setStaff((l) => upsert(l, m)), []),
    dropService: useCallback((id: string) => {
      setServices((l) => l.filter((s) => s.id !== id));
    }, []),
    dropStaff: useCallback((id: string) => {
      setStaff((l) => l.filter((m) => m.id !== id));
      // A removed member performs nothing: keep the service rows honest.
      setServices((l) =>
        l.map((s) => (s.staffIds?.includes(id) ? { ...s, staffIds: s.staffIds.filter((t) => t !== id) } : s)),
      );
    }, []),
  };
}

/** Does `m` perform `s`? Providers report the link on the service, the staff
 *  member, or both. Undefined when neither side says. */
export function performs(s: Service, m: Staff): boolean | undefined {
  if (s.staffIds) return s.staffIds.includes(m.id);
  if (m.serviceIds) return m.serviceIds.includes(s.id);
  return undefined;
}

/** Two-letter initials for a performer mark. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Minor units → "45.00 USD"-style display, in the visitor's locale. */
export function money(p: Service['price']): string {
  if (!p) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency }).format(
      p.amount / 100,
    );
  } catch {
    return `${(p.amount / 100).toFixed(2)} ${p.currency}`;
  }
}

/** Minutes → "45 min" / "1 h 30 min". */
export function minutes(m: number | undefined): string {
  if (m === undefined) return '';
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
}
