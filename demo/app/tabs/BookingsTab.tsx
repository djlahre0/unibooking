'use client';

import { useState } from 'react';
import {
  type ActionResult,
  type Connection,
  callCreateBooking,
  callGetBooking,
  callUpdateBooking,
  callCancelBooking,
  callMarkCancelled,
  callListBookings,
} from '../../lib/call';
import { CALENDAR_PROVIDERS, EVENT_STATUS_LABELS } from '../../lib/cancel-event';

/** Statuses a calendar event can be given (see setEventStatus). */
const CALENDAR_STATUSES = Object.entries(EVENT_STATUS_LABELS);
/** Booking-platform statuses an update can set. Cancelling has its own op. */
const PLATFORM_STATUSES: [string, string][] = [
  ['confirmed', 'Confirmed'],
  ['pending', 'Pending'],
  ['completed', 'Completed'],
  ['no_show', 'No-show'],
];
import type { ProviderMeta } from '../../lib/providers';
import { browserZone, isTimeZone, toInstant } from '../../lib/datetime';
import ResultBox from '../ResultBox';
import ApiHint from '../ApiHint';
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
  // Calendar events can be cancelled (kept, marked cancelled) or deleted;
  // booking platforms only cancel. A 'delete' left selected from a calendar
  // provider falls back to 'cancel' after switching to one of those.
  const isCalendar = CALENDAR_PROVIDERS.has(selectedProvider);
  const ops = isCalendar
    ? ['create', 'get', 'update', 'cancel', 'delete', 'list']
    : ['create', 'get', 'update', 'cancel', 'list'];
  const activeOp = bookingOp === 'delete' && !isCalendar ? 'cancel' : bookingOp;

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
            {ops.map((op) => (
              <button
                key={op}
                className={`btn btn-sm ${activeOp === op ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => {
                  setBookingOp(op);
                  setBookingResult(null);
                }}
              >
                {op === 'create' && '➕ '}
                {op === 'get' && '🔍 '}
                {op === 'update' && '✏️ '}
                {op === 'cancel' && (isCalendar ? '🚫 ' : '🗑 ')}
                {op === 'delete' && '🗑 '}
                {op === 'list' && '📋 '}
                {op.charAt(0).toUpperCase() + op.slice(1)}
              </button>
            ))}
          </div>

          {/* Create Booking */}
          {activeOp === 'create' && (
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
              <ApiHint call="client.createBooking({ title, range, serviceId, staffId, customer })" />
            </PersistedForm>
          )}

          {/* Get Booking */}
          {activeOp === 'get' && (
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
              <ApiHint call="client.getBooking(id)" />
            </PersistedForm>
          )}

          {/* Update Booking */}
          {activeOp === 'update' && (
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
                      status: (fd.get('status') as string) || undefined,
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
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-status">
                    New Status
                  </label>
                  <select id="bk-new-status" name="status" className="form-select" defaultValue="">
                    <option value="">Leave unchanged</option>
                    {(isCalendar ? CALENDAR_STATUSES : PLATFORM_STATUSES).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    {isCalendar
                      ? 'Cancelled keeps the event, marked; Confirmed or Tentative restores a cancelled one.'
                      : 'Support varies by provider; to cancel a booking use Cancel.'}
                  </span>
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
              <ApiHint call={isCalendar ? 'client.updateBooking(id, { range, title, status })' : 'client.updateBooking(id, { range, staffId, status })'} />
            </PersistedForm>
          )}

          {/* Cancel Booking — on a calendar, keeps the event marked cancelled */}
          {activeOp === 'cancel' && (
            <PersistedForm
              formKey="bookings:cancel"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const id = fd.get('bookingId') as string;
                const reason = (fd.get('reason') as string) || undefined;
                wrap(
                  'booking',
                  () =>
                    isCalendar
                      ? callMarkCancelled(selectedProvider, conn, id, reason)
                      : callCancelBooking(selectedProvider, conn, id, reason),
                  setBookingResult,
                );
              }}
            >
              {isCalendar ? (
                <p className="cal-muted">
                  Keeps the event on the calendar, retitled &ldquo;Cancelled: &hellip;&rdquo; and no
                  longer blocking the time; guests are notified. To remove it entirely, use Delete.
                </p>
              ) : null}
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
                {busy('booking') ? '...' : isCalendar ? '🚫 Cancel Event' : '🗑 Cancel Booking'}
              </button>
              {isCalendar ? (
                <ApiHint call="client.getBooking(id) + client.updateBooking(id, { title, status })">Keeps the event, marked cancelled.</ApiHint>
              ) : (
                <ApiHint call="client.cancelBooking(id, { reason })" />
              )}
            </PersistedForm>
          )}

          {/* Delete Event — calendar providers only: removes it for good */}
          {activeOp === 'delete' && (
            <PersistedForm
              formKey="bookings:delete"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const id = fd.get('bookingId') as string;
                if (!window.confirm(`Permanently delete event ${id}? This cannot be undone.`)) {
                  return;
                }
                wrap(
                  'booking',
                  // The library's cancelBooking() is a delete on calendars.
                  () => callCancelBooking(selectedProvider, conn, id),
                  setBookingResult,
                );
              }}
            >
              <p className="cal-muted">
                Removes the event from the calendar permanently. This cannot be undone.
              </p>
              <div className="form-group">
                <label className="form-label" htmlFor="bk-booking-id-4">
                  Booking ID
                </label>
                <input
                  id="bk-booking-id-4"
                  name="bookingId"
                  className="form-input"
                  placeholder="ID to delete"
                  required
                />
              </div>
              <button
                className="btn btn-secondary cal-danger"
                type="submit"
                disabled={busy('booking')}
                style={{ marginTop: '1rem' }}
              >
                {busy('booking') ? '...' : '🗑 Delete Event'}
              </button>
              <ApiHint call="client.cancelBooking(id)">On a calendar this deletes the event.</ApiHint>
            </PersistedForm>
          )}

          {/* List Bookings */}
          {activeOp === 'list' && (
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
              <ApiHint call="client.listBookings({ range, limit, pageToken })" />
            </PersistedForm>
          )}

          <ResultBox result={bookingResult} label={`${activeOp} result`} elapsedMs={elapsedMs} />
        </div>
      )}
    </div>
  );
}
