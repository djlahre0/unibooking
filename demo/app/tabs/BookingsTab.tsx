'use client';

import { useState } from 'react';
import {
  type ActionResult,
  type Connection,
  callCreateBooking,
  callGetBooking,
  callUpdateBooking,
  callCancelBooking,
  callListBookings,
} from '../../lib/call';
import type { ProviderMeta } from '../../lib/providers';
import { browserZone, isTimeZone, toInstant } from '../../lib/datetime';
import ResultBox from '../ResultBox';
import PersistedForm from '../PersistedForm';
import { useCalendarZone, type CalendarZone } from './useCalendarZone';

export type BookingsTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  /** Today-relative date defaults, computed once in page.tsx so every tab
   *  shows the same window and none can go stale. `start`/`end` are the wide
   *  list window; `slotStart`/`slotEnd` are a concrete upcoming booking slot. */
  defaultRange: { start: string; end: string; slotStart: string; slotEnd: string };
  bookingResult: ActionResult | null;
  setBookingResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  /** How long the last call took, measured in page.tsx's `wrap`. */
  elapsedMs?: number;
};

/** The date and time halves of an RFC3339 instant, for the pickers' defaults. */
const day = (instant: string): string => instant.slice(0, 10);
const clock = (instant: string): string => instant.slice(11, 16);

/**
 * A date picker and a time picker for one end of a range, as two grid cells.
 * Submitted as `<name>Date` / `<name>Time`; `pickedInstant` joins them.
 */
function DateTimePair({
  idPrefix,
  name,
  label,
  instant,
  required,
}: {
  idPrefix: string;
  name: string;
  label: string;
  /** Default value, as an RFC3339 instant. Omitted leaves both pickers blank. */
  instant?: string;
  required?: boolean;
}) {
  return (
    <>
      <div className="form-group">
        <label className="form-label" htmlFor={`${idPrefix}-date`}>
          {label} date
        </label>
        <input
          id={`${idPrefix}-date`}
          name={`${name}Date`}
          type="date"
          className="form-input"
          defaultValue={instant ? day(instant) : undefined}
          required={required}
        />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={`${idPrefix}-time`}>
          {label} time
        </label>
        <input
          id={`${idPrefix}-time`}
          name={`${name}Time`}
          type="time"
          className="form-input"
          defaultValue={instant ? clock(instant) : undefined}
          required={required}
        />
      </div>
    </>
  );
}

/**
 * The optional zone override plus a line saying which zone the pickers are
 * actually read in. Blank means "the calendar's own zone" (or this browser's
 * when the provider reports none). Named `zoneOverride`, not `timezone`: the
 * browser zone that earlier versions auto-filled and saved must not silently
 * pin every restored form to the laptop's zone.
 */
function ZoneField({ idPrefix, zone }: { idPrefix: string; zone: CalendarZone | null }) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={`${idPrefix}-zone`}>
        Timezone override (IANA)
      </label>
      <input
        id={`${idPrefix}-zone`}
        name="zoneOverride"
        className="form-input"
        placeholder={zone ? zone.zone : 'Optional'}
        aria-describedby={`${idPrefix}-zone-hint`}
      />
      <small id={`${idPrefix}-zone-hint`} className="form-hint">
        {!zone
          ? "Looking up the calendar's time zone..."
          : zone.from === 'calendar'
            ? `Times are in ${zone.zone}, the time zone of "${zone.calendarName}".`
            : `Times are in ${zone.zone}, this browser's time zone.`}
      </small>
    </div>
  );
}

/**
 * A form's picked date + time for one end, as an instant in the effective
 * zone; `''` when the date is blank (an optional end left empty).
 *
 * Throws on input that would otherwise be sent wrong without a word: a typo'd
 * override zone (`toInstant` would fall back to an offset-less string) or a
 * time with no date (it would simply be dropped). Called inside `wrap`, which
 * shows the message as the call's result.
 */
function pickedInstant(
  fd: FormData,
  name: string,
  label: string,
  zone: CalendarZone | null,
): string {
  const str = (k: string): string => ((fd.get(k) as string) ?? '').trim();
  const override = str('zoneOverride');
  if (override && !isTimeZone(override)) {
    throw new Error(`"${override}" is not an IANA time zone name, e.g. Europe/London.`);
  }
  const date = str(`${name}Date`);
  const time = str(`${name}Time`);
  if (time && !date) throw new Error(`${label}: pick a date as well as a time.`);
  return toInstant(date, time, override || zone?.zone || browserZone());
}

export default function BookingsTab({
  selectedProvider,
  providerInfo,
  conn,
  defaultRange,
  bookingResult,
  setBookingResult,
  wrap,
  busy,
  elapsedMs,
}: BookingsTabProps) {
  const [bookingOp, setBookingOp] = useState('create');
  // Picked wall-clock times are anchored in the targeted calendar's zone, so
  // "10:00" lands at 10:00 on that calendar, not in the laptop's zone.
  const zone = useCalendarZone(selectedProvider, conn);

  return (
    <div className="fade-in">
      {!selectedProvider ? (
        <div className="empty-state">
          <span className="icon">📅</span>
          Select a provider in the Connect tab first
        </div>
      ) : (
        <div className="card">
          <div className="card-title">
            <span className="icon">📅</span> Booking CRUD — {providerInfo?.label}
          </div>

          <div className="op-row">
            {['create', 'get', 'update', 'cancel', 'list'].map((op) => (
              <button
                key={op}
                className={`btn btn-sm ${bookingOp === op ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => {
                  setBookingOp(op);
                  setBookingResult(null);
                }}
              >
                {op === 'create' && '➕ '}
                {op === 'get' && '🔍 '}
                {op === 'update' && '✏️ '}
                {op === 'cancel' && '🗑 '}
                {op === 'list' && '📋 '}
                {op.charAt(0).toUpperCase() + op.slice(1)}
              </button>
            ))}
          </div>

          {/* Create Booking */}
          {bookingOp === 'create' && (
            <PersistedForm
              formKey="bookings:create"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                // One zone anchors both ends; the instants then carry the
                // offset, so the provider gets an unambiguous range.
                wrap(
                  'booking',
                  () =>
                    callCreateBooking(selectedProvider, conn, {
                      title: fd.get('title') as string,
                      start: pickedInstant(fd, 'start', 'Start', zone),
                      end: pickedInstant(fd, 'end', 'End', zone),
                      serviceId: (fd.get('serviceId') as string) || undefined,
                      staffId: (fd.get('staffId') as string) || undefined,
                      customerName: (fd.get('customerName') as string) || undefined,
                      customerEmail: (fd.get('customerEmail') as string) || undefined,
                      idempotencyKey: (fd.get('idempotencyKey') as string) || undefined,
                    }),
                  setBookingResult,
                );
              }}
            >
              <div className="two-col">
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-title">
                    Title
                  </label>
                  <input
                    id="bk-title"
                    name="title"
                    className="form-input"
                    placeholder="Haircut — Jane"
                    defaultValue="Demo Booking"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-service-id">
                    Service ID
                  </label>
                  <input
                    id="bk-service-id"
                    name="serviceId"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <DateTimePair
                  idPrefix="bk-start"
                  name="start"
                  label="Start"
                  instant={defaultRange.slotStart}
                  required
                />
                <DateTimePair
                  idPrefix="bk-end"
                  name="end"
                  label="End"
                  instant={defaultRange.slotEnd}
                  required
                />
                <ZoneField idPrefix="bk-create" zone={zone} />
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-staff-id">
                    Staff ID
                  </label>
                  <input
                    id="bk-staff-id"
                    name="staffId"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-idempotency-key">
                    Idempotency Key
                  </label>
                  <input
                    id="bk-idempotency-key"
                    name="idempotencyKey"
                    className="form-input"
                    placeholder="Optional UUID"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-customer-name">
                    Customer Name
                  </label>
                  <input
                    id="bk-customer-name"
                    name="customerName"
                    className="form-input"
                    placeholder="Jane Doe"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-customer-email">
                    Customer Email
                  </label>
                  <input
                    id="bk-customer-email"
                    name="customerEmail"
                    className="form-input"
                    placeholder="jane@example.com"
                  />
                </div>
              </div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy('booking')}
                style={{ marginTop: '1rem' }}
              >
                {busy('booking') ? '...' : '➕ Create Booking'}
              </button>
            </PersistedForm>
          )}

          {/* Get Booking */}
          {bookingOp === 'get' && (
            <PersistedForm
              formKey="bookings:get"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                wrap(
                  'booking',
                  () => callGetBooking(selectedProvider, conn, fd.get('bookingId') as string),
                  setBookingResult,
                );
              }}
            >
              <div className="form-group">
                <label className="form-label" htmlFor="bk-booking-id">
                  Booking ID
                </label>
                <input
                  id="bk-booking-id"
                  name="bookingId"
                  className="form-input"
                  placeholder="Enter booking ID"
                  required
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy('booking')}>
                {busy('booking') ? '...' : '🔍 Get Booking'}
              </button>
            </PersistedForm>
          )}

          {/* Update Booking */}
          {bookingOp === 'update' && (
            <PersistedForm
              formKey="bookings:update"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                wrap(
                  'booking',
                  () =>
                    callUpdateBooking(selectedProvider, conn, fd.get('bookingId') as string, {
                      title: (fd.get('title') as string) || undefined,
                      start: pickedInstant(fd, 'start', 'New start', zone) || undefined,
                      end: pickedInstant(fd, 'end', 'New end', zone) || undefined,
                      staffId: (fd.get('staffId') as string) || undefined,
                      serviceId: (fd.get('serviceId') as string) || undefined,
                    }),
                  setBookingResult,
                );
              }}
            >
              <div className="two-col">
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-booking-id-2">
                    Booking ID
                  </label>
                  <input
                    id="bk-booking-id-2"
                    name="bookingId"
                    className="form-input"
                    placeholder="ID to update"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-title">
                    New Title
                  </label>
                  <input
                    id="bk-new-title"
                    name="title"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <DateTimePair idPrefix="bk-new-start" name="start" label="New start" />
                <DateTimePair idPrefix="bk-new-end" name="end" label="New end" />
                <ZoneField idPrefix="bk-update" zone={zone} />
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-staff-id">
                    New Staff ID
                  </label>
                  <input
                    id="bk-new-staff-id"
                    name="staffId"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-service-id">
                    New Service ID
                  </label>
                  <input
                    id="bk-new-service-id"
                    name="serviceId"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
              </div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy('booking')}
                style={{ marginTop: '1rem' }}
              >
                {busy('booking') ? '...' : '✏️ Update Booking'}
              </button>
            </PersistedForm>
          )}

          {/* Cancel Booking */}
          {bookingOp === 'cancel' && (
            <PersistedForm
              formKey="bookings:cancel"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                wrap(
                  'booking',
                  () =>
                    callCancelBooking(
                      selectedProvider,
                      conn,
                      fd.get('bookingId') as string,
                      (fd.get('reason') as string) || undefined,
                    ),
                  setBookingResult,
                );
              }}
            >
              <div className="two-col">
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-booking-id-3">
                    Booking ID
                  </label>
                  <input
                    id="bk-booking-id-3"
                    name="bookingId"
                    className="form-input"
                    placeholder="ID to cancel"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-reason">
                    Reason
                  </label>
                  <input
                    id="bk-reason"
                    name="reason"
                    className="form-input"
                    placeholder="Optional cancellation reason"
                  />
                </div>
              </div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy('booking')}
                style={{ marginTop: '1rem' }}
              >
                {busy('booking') ? '...' : '🗑 Cancel Booking'}
              </button>
            </PersistedForm>
          )}

          {/* List Bookings */}
          {bookingOp === 'list' && (
            <PersistedForm
              formKey="bookings:list"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                wrap(
                  'booking',
                  () =>
                    callListBookings(selectedProvider, conn, {
                      start: pickedInstant(fd, 'start', 'From', zone),
                      end: pickedInstant(fd, 'end', 'To', zone),
                      limit: (fd.get('limit') as string) ? Number(fd.get('limit')) : undefined,
                      pageToken: (fd.get('pageToken') as string) || undefined,
                    }),
                  setBookingResult,
                );
              }}
            >
              <div className="two-col">
                <DateTimePair
                  idPrefix="bk-list-start"
                  name="start"
                  label="From"
                  instant={defaultRange.start}
                  required
                />
                <DateTimePair
                  idPrefix="bk-list-end"
                  name="end"
                  label="To"
                  instant={defaultRange.end}
                  required
                />
                <ZoneField idPrefix="bk-list" zone={zone} />
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-limit">
                    Limit
                  </label>
                  <input
                    id="bk-limit"
                    name="limit"
                    className="form-input"
                    placeholder="Optional page size"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-page-token">
                    Page Token
                  </label>
                  <input
                    id="bk-page-token"
                    name="pageToken"
                    className="form-input"
                    placeholder="Optional (from prev response)"
                  />
                </div>
              </div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy('booking')}
                style={{ marginTop: '1rem' }}
              >
                {busy('booking') ? '...' : '📋 List Bookings'}
              </button>
            </PersistedForm>
          )}

          <ResultBox result={bookingResult} label={`${bookingOp} result`} elapsedMs={elapsedMs} />
        </div>
      )}
    </div>
  );
}
