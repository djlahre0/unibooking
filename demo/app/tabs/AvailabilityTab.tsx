'use client';

import { useEffect, useRef } from 'react';
import { type ActionResult, type Connection, callSearchAvailability } from '../../lib/call';
import type { ProviderMeta } from '../../lib/providers';
import { browserZone, toInstant } from '../../lib/datetime';
import ResultBox from '../ResultBox';
import ApiHint from '../ApiHint';
import PersistedForm from '../PersistedForm';

export type AvailabilityTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  availResult: ActionResult | null;
  setAvailResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  /** Today-relative date defaults, computed once in page.tsx so every tab
   *  shows the same window and none can go stale. `dayStart`/`dayEnd` are the
   *  single upcoming day this tab searches. */
  defaultRange: { dayStart: string; dayEnd: string };
  /** How long the last call took, measured in page.tsx's `wrap`. */
  elapsedMs?: number;
};

/** The date and time halves of an RFC3339 instant, for the pickers' defaults. */
const day = (instant: string): string => instant.slice(0, 10);
const clock = (instant: string): string => instant.slice(11, 16);

export default function AvailabilityTab({
  selectedProvider,
  providerInfo,
  conn,
  availResult,
  setAvailResult,
  defaultRange,
  wrap,
  busy,
  elapsedMs,
}: AvailabilityTabProps) {
  const root = useRef<HTMLDivElement>(null);

  // The visitor's own zone cannot be a `defaultValue`: the server render has
  // no access to it, so writing it into the HTML would break hydration. Filled
  // in after mount instead, and only when still blank — PersistedForm's own
  // restore effect runs first (child effects before parent), so a zone the
  // visitor previously typed always wins over this default.
  useEffect(() => {
    const el = root.current?.querySelector<HTMLInputElement>('#av-timezone');
    if (el && !el.value) el.value = browserZone();
  }, [selectedProvider]);

  return (
    <div className="fade-in" ref={root}>
      {!selectedProvider ? (
        <div className="empty-state">
          <span className="icon">🕐</span>
          Select a provider in the Connect tab first
        </div>
      ) : (
        <div className="card">
          <div className="card-title">
            <span className="icon">🕐</span> Search Availability — {providerInfo?.label}
          </div>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              marginBottom: '1rem',
            }}
          >
            <code>client.searchAvailability(query)</code> — only works when{' '}
            <code>capabilities.availability</code> is <code>true</code>
          </p>
          <PersistedForm
            formKey="availability:search"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const str = (k: string): string => ((fd.get(k) as string) ?? '').trim();
              // One zone anchors both ends, so the window can never be built
              // from two different offsets. The instants carry that offset, so
              // the provider receives an unambiguous range either way.
              const timezone = str('timezone') || browserZone();
              const duration = Number(str('durationMinutes'));
              const range = {
                start: toInstant(str('startDate'), str('startTime'), timezone),
                end: toInstant(str('endDate'), str('endTime'), timezone),
              };
              // Only the selected provider's own availability: nothing from
              // any other provider is mixed in.
              wrap(
                'avail',
                () =>
                  callSearchAvailability(selectedProvider, conn, {
                    ...range,
                    timezone,
                    ...(Number.isFinite(duration) && duration > 0
                      ? { durationMinutes: duration }
                      : {}),
                    ...(str('serviceId') ? { serviceId: str('serviceId') } : {}),
                    ...(str('staffId') ? { staffId: str('staffId') } : {}),
                  }),
                setAvailResult,
              );
            }}
          >
            <div className="two-col">
              <div className="form-group">
                <label className="form-label" htmlFor="av-start-date">
                  Start date
                </label>
                <input
                  id="av-start-date"
                  name="startDate"
                  type="date"
                  className="form-input"
                  defaultValue={day(defaultRange.dayStart)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="av-start-time">
                  Start time
                </label>
                <input
                  id="av-start-time"
                  name="startTime"
                  type="time"
                  className="form-input"
                  defaultValue={clock(defaultRange.dayStart)}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="av-end-date">
                  End date
                </label>
                <input
                  id="av-end-date"
                  name="endDate"
                  type="date"
                  className="form-input"
                  defaultValue={day(defaultRange.dayEnd)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="av-end-time">
                  End time
                </label>
                <input
                  id="av-end-time"
                  name="endTime"
                  type="time"
                  className="form-input"
                  defaultValue={clock(defaultRange.dayEnd)}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="av-duration">
                  Slot length (minutes)
                </label>
                <input
                  id="av-duration"
                  name="durationMinutes"
                  type="number"
                  min="1"
                  // No `step`: it defaults to 1, so any whole number of
                  // minutes is valid. `step="5"` with `min="1"` would make the
                  // valid sequence 1, 6, 11 … — the default of 30 would be a
                  // stepMismatch and the browser would silently refuse to
                  // submit the form, with no visible error.
                  className="form-input"
                  defaultValue="30"
                />
                <small style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>
                  Google returns busy intervals, so it needs this to size each free slot.
                </small>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="av-timezone">
                  Timezone (IANA)
                </label>
                <input
                  id="av-timezone"
                  name="timezone"
                  className="form-input"
                  placeholder="Detected from this browser"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="av-service-id">
                  Service ID
                </label>
                <input
                  id="av-service-id"
                  name="serviceId"
                  className="form-input"
                  placeholder="Optional"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="av-staff-id">
                  Staff ID
                </label>
                <input
                  id="av-staff-id"
                  name="staffId"
                  className="form-input"
                  placeholder="Optional"
                />
              </div>
            </div>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy('avail')}
              style={{ marginTop: '1rem' }}
            >
              {busy('avail') ? '...' : '🔍 Search Slots'}
            </button>
            <ApiHint call="client.searchAvailability({ range, serviceId, staffId, durationMinutes })" />
          </PersistedForm>
          <ResultBox result={availResult} label="Availability" elapsedMs={elapsedMs} />
        </div>
      )}
    </div>
  );
}
