'use client';

import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../lib/call';
import { dayLabel } from '../lib/calendar/agenda';

/* ═══════════════════════════════════════════════════════════
   Canonical shape detection

   The demo's ActionResult.data is `unknown` -- it is whatever a provider
   adapter returned, forwarded verbatim. These guards recognize the shapes
   unibooking actually documents (ListBookingsResult, ListServicesResult,
   ListStaffResult, AvailabilitySlot[] -- see src/types.ts) and render a
   table for them; anything else falls back to pretty-printed JSON, same as
   the previous version of this component did for everything.
   ═══════════════════════════════════════════════════════════ */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

type Money = { amount: number; currency: string };
type Customer = { id?: string; name?: string; email?: string; phone?: string };
type BookingLike = {
  id?: string;
  title?: string;
  range?: { start?: string; end?: string };
  customer?: Customer;
  staffId?: string;
  status?: string;
};
type ServiceLike = {
  id?: string;
  name?: string;
  durationMinutes?: number;
  price?: Money;
  active?: boolean;
};
type StaffLike = { id?: string; name?: string; email?: string; active?: boolean };
type SlotLike = { start?: string; end?: string; staffId?: string };

function isBookingsPayload(data: unknown): data is { bookings: BookingLike[] } {
  return isRecord(data) && Array.isArray(data.bookings);
}
function isServicesPayload(data: unknown): data is { services: ServiceLike[] } {
  return isRecord(data) && Array.isArray(data.services);
}
function isStaffPayload(data: unknown): data is { staff: StaffLike[] } {
  return isRecord(data) && Array.isArray(data.staff);
}
/** A bare array of {start, end, ...} is the shape searchAvailability returns
 *  (AvailabilitySlot[], not wrapped in an envelope) -- unlike the three list
 *  results above, which are always `{ <name>: [...] }`. */
function isSlotsPayload(data: unknown): data is SlotLike[] {
  return (
    Array.isArray(data) &&
    data.every((s) => isRecord(s) && typeof s.start === 'string' && typeof s.end === 'string')
  );
}

/** True RFC3339 instants only -- guards the string slicing below against a
 *  malformed or missing timestamp from a misbehaving provider response. */
const INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

function dateOf(instant: string | undefined): string | undefined {
  return instant ? INSTANT_RE.exec(instant)?.[1] : undefined;
}
function timeOf(instant: string | undefined): string {
  if (!instant) return '—';
  return INSTANT_RE.exec(instant)?.[2] ?? instant;
}

/** Integer minor units -> a currency string, e.g. 4500 USD -> $45.00, per
 *  Money's own doc comment in src/types.ts ("4500 = $45.00"). Intl supplies
 *  the symbol/placement; the /100 conversion is fixed because the demo has
 *  no per-currency minor-unit table and the design brief's example is /100. */
function formatMoney(price: Money | undefined): string {
  if (!price) return '—';
  const major = price.amount / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    // An unrecognized ISO-4217 code -- still show the number rather than
    // throwing away the response.
    return `${major.toFixed(2)} ${price.currency}`;
  }
}

/* ═══════════════════════════════════════════════════════════
   Status colour mapping -- pine = confirmed/active, amber = pending,
   rose = cancelled/error, ink-faint = completed/inactive. Booking statuses
   the design system doesn't name explicitly (declined, no_show, unknown)
   are folded into the nearest meaning: a decline or no-show reads as a
   failed appointment (rose), same family as cancelled; unknown is neutral
   like completed/inactive (ink-faint).
   ═══════════════════════════════════════════════════════════ */
const STATUS_TONE: Record<string, 'pine' | 'amber' | 'rose' | 'inkfaint'> = {
  confirmed: 'pine',
  pending: 'amber',
  cancelled: 'rose',
  declined: 'rose',
  no_show: 'rose',
  completed: 'inkfaint',
  unknown: 'inkfaint',
};

function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="rb-status rb-status-inkfaint">—</span>;
  const tone = STATUS_TONE[status] ?? 'inkfaint';
  return <span className={`rb-status rb-status-${tone}`}>{status.replace('_', ' ')}</span>;
}

function ActiveBadge({ active }: { active: boolean | undefined }) {
  return (
    <span className={`rb-status ${active ? 'rb-status-pine' : 'rb-status-inkfaint'}`}>
      {active ? 'active' : 'inactive'}
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════
   Bookings -> a schedule grouped by day, the panel the design system calls
   out as the second place (after the provider rail) worth spending
   boldness on.
   ═══════════════════════════════════════════════════════════ */
type DayGroup = { key: string; label: string; items: BookingLike[] };

function groupByDay(bookings: BookingLike[]): DayGroup[] {
  const byDate = new Map<string, BookingLike[]>();
  const unscheduled: BookingLike[] = [];
  for (const b of bookings) {
    const d = dateOf(b.range?.start);
    if (!d) {
      unscheduled.push(b);
      continue;
    }
    byDate.set(d, [...(byDate.get(d) ?? []), b]);
  }
  const groups: DayGroup[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      key: date,
      label: dayLabel(date),
      items: items.sort((a, b) => (a.range?.start ?? '').localeCompare(b.range?.start ?? '')),
    }));
  if (unscheduled.length > 0) {
    groups.push({ key: 'unscheduled', label: 'Unscheduled', items: unscheduled });
  }
  return groups;
}

function Schedule({ bookings }: { bookings: BookingLike[] }) {
  if (bookings.length === 0) return <p className="rb-empty">No bookings in this range.</p>;
  const groups = groupByDay(bookings);
  return (
    <div className="rb-schedule">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="rb-day-label">{g.label}</div>
          <table className="rb-table">
            <tbody>
              {g.items.map((b, i) => (
                <tr key={b.id ?? i}>
                  <td className="rb-mono">{timeOf(b.range?.start)}</td>
                  <td>{b.title || '—'}</td>
                  <td>{b.customer?.name ?? b.customer?.email ?? '—'}</td>
                  <td className="rb-mono">{b.staffId ?? '—'}</td>
                  <td>
                    <StatusBadge status={b.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function ServicesTable({ services }: { services: ServiceLike[] }) {
  if (services.length === 0) return <p className="rb-empty">No services returned.</p>;
  return (
    <table className="rb-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Duration</th>
          <th>Price</th>
          <th>Active</th>
        </tr>
      </thead>
      <tbody>
        {services.map((s, i) => (
          <tr key={s.id ?? i}>
            <td>{s.name || '—'}</td>
            <td className="rb-mono">
              {s.durationMinutes != null ? `${s.durationMinutes} min` : '—'}
            </td>
            <td className="rb-mono">{formatMoney(s.price)}</td>
            <td>
              <ActiveBadge active={s.active} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StaffTable({ staff }: { staff: StaffLike[] }) {
  if (staff.length === 0) return <p className="rb-empty">No staff returned.</p>;
  return (
    <table className="rb-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Active</th>
        </tr>
      </thead>
      <tbody>
        {staff.map((s, i) => (
          <tr key={s.id ?? i}>
            <td>{s.name || '—'}</td>
            <td className="rb-mono">{s.email ?? '—'}</td>
            <td>
              <ActiveBadge active={s.active} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SlotsTable({ slots }: { slots: SlotLike[] }) {
  if (slots.length === 0) return <p className="rb-empty">No open slots in this range.</p>;
  return (
    <table className="rb-table">
      <thead>
        <tr>
          <th>Start</th>
          <th>End</th>
          <th>Staff</th>
        </tr>
      </thead>
      <tbody>
        {slots.map((s, i) => (
          <tr key={i}>
            <td className="rb-mono">{s.start ?? '—'}</td>
            <td className="rb-mono">{s.end ?? '—'}</td>
            <td className="rb-mono">{s.staffId ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The disclosure's raw payload -- only rendered alongside a table view, so
 *  the "anything else -> pretty JSON" fallback never duplicates itself. */
function RawJson({ value }: { value: unknown }) {
  return (
    <details className="rb-raw">
      <summary>Raw JSON</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function ErrorView({ error }: { error: NonNullable<ActionResult['error']> }) {
  return (
    <div className="rb-error">
      <div className="rb-error-top">
        {error.code ? <span className="rb-mono rb-error-code">{error.code}</span> : null}
        <span className={`rb-status ${error.retryable ? 'rb-status-amber' : 'rb-status-inkfaint'}`}>
          {error.retryable ? 'Retryable' : 'Not retryable'}
        </span>
      </div>
      <p className="rb-error-message">{error.message}</p>
    </div>
  );
}

export default function ResultBox({
  result,
  label,
  elapsedMs,
}: {
  result: ActionResult | null;
  label?: string;
  /** Wall-clock time the call took, measured by `wrap` in page.tsx with
   *  `performance.now()`. Not part of ActionResult -- that type is also
   *  produced by the server proxy route and by serializeError, neither of
   *  which knows how long the round trip took from the browser's side. */
  elapsedMs?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  if (!result) return null;

  const data = result.ok ? result.data : undefined;
  const payload = result.ok ? result.data : result.error;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied (insecure context, permission policy, or no
      // clipboard API in this test environment) -- the JSON is still visible
      // to select and copy by hand, so this fails quietly.
    }
  };

  const nextPageToken =
    isRecord(data) && typeof data.nextPageToken === 'string' && data.nextPageToken
      ? data.nextPageToken
      : undefined;

  let body: React.ReactNode;
  let raw: React.ReactNode = null;
  if (result.ok) {
    if (isBookingsPayload(data)) {
      body = <Schedule bookings={data.bookings} />;
      raw = <RawJson value={data} />;
    } else if (isServicesPayload(data)) {
      body = <ServicesTable services={data.services} />;
      raw = <RawJson value={data} />;
    } else if (isStaffPayload(data)) {
      body = <StaffTable staff={data.staff} />;
      raw = <RawJson value={data} />;
    } else if (isSlotsPayload(data)) {
      body = <SlotsTable slots={data} />;
      raw = <RawJson value={data} />;
    } else {
      body = <pre className="rb-plain">{JSON.stringify(data, null, 2)}</pre>;
    }
  } else {
    body = result.error ? (
      <ErrorView error={result.error} />
    ) : (
      <p className="rb-error-message">Something failed, but no error detail was returned.</p>
    );
    raw = <RawJson value={result.error} />;
  }

  return (
    <div className="rb-panel fade-in">
      <div className="rb-header">
        {label ? <span className="rb-label">{label}</span> : null}
        <span className={`rb-outcome ${result.ok ? 'rb-outcome-ok' : 'rb-outcome-error'}`}>
          {result.ok ? 'Succeeded' : 'Failed'}
        </span>
        {elapsedMs != null ? <span className="rb-timing">{Math.round(elapsedMs)} ms</span> : null}
        <button type="button" className="btn btn-sm rb-copy" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="rb-body">
        {body}
        {nextPageToken ? <p className="rb-more">More results available</p> : null}
      </div>
      {raw}
    </div>
  );
}
