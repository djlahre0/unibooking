'use client';

import { useEffect, useRef, useState } from 'react';
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
import { browserZone, toInstant } from '../../lib/datetime';
import ResultBox from '../ResultBox';
import PersistedForm from '../PersistedForm';

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
  const root = useRef<HTMLDivElement>(null);

  // The visitor's zone is unknown to the server render, so it cannot be a
  // `defaultValue` without breaking hydration. Filled after mount, and only
  // when blank so a restored or typed value always wins. Re-runs per op
  // because each op renders its own form.
  useEffect(() => {
    const el = root.current?.querySelector<HTMLInputElement>('#bk-timezone');
    if (el && !el.value) el.value = browserZone();
  }, [bookingOp, selectedProvider]);

  return (
    <div className="fade-in" ref={root}>
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
                const str = (k: string): string => ((fd.get(k) as string) ?? '').trim();
                // One zone anchors both ends; the instants then carry the
                // offset, so the provider gets an unambiguous range.
                const tz = str('timezone') || browserZone();
                wrap(
                  'booking',
                  () =>
                    callCreateBooking(selectedProvider, conn, {
                      title: fd.get('title') as string,
                      start: toInstant(str('startDate'), str('startTime'), tz),
                      end: toInstant(str('endDate'), str('endTime'), tz),
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
                  <label className="form-label" htmlFor="bk-title">Title</label>
                  <input
                    id="bk-title"
                    name="title"
                    className="form-input"
                    placeholder="Haircut — Jane"
                    defaultValue="Demo Booking"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-service-id">Service ID</label>
                  <input
                    id="bk-service-id"
                    name="serviceId"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-start-date">
                    Start date
                  </label>
                  <input
                    id="bk-start-date"
                    name="startDate"
                    type="date"
                    className="form-input"
                    defaultValue={day(defaultRange.slotStart)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-start-time">
                    Start time
                  </label>
                  <input
                    id="bk-start-time"
                    name="startTime"
                    type="time"
                    className="form-input"
                    defaultValue={clock(defaultRange.slotStart)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-end-date">
                    End date
                  </label>
                  <input
                    id="bk-end-date"
                    name="endDate"
                    type="date"
                    className="form-input"
                    defaultValue={day(defaultRange.slotEnd)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-end-time">
                    End time
                  </label>
                  <input
                    id="bk-end-time"
                    name="endTime"
                    type="time"
                    className="form-input"
                    defaultValue={clock(defaultRange.slotEnd)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-timezone">
                    Timezone (IANA)
                  </label>
                  <input
                    id="bk-timezone"
                    name="timezone"
                    className="form-input"
                    placeholder="Detected from this browser"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-staff-id">Staff ID</label>
                  <input
                    id="bk-staff-id"
                    name="staffId"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-idempotency-key">Idempotency Key</label>
                  <input
                    id="bk-idempotency-key"
                    name="idempotencyKey"
                    className="form-input"
                    placeholder="Optional UUID"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-customer-name">Customer Name</label>
                  <input
                    id="bk-customer-name"
                    name="customerName"
                    className="form-input"
                    placeholder="Jane Doe"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-customer-email">Customer Email</label>
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
                <label className="form-label" htmlFor="bk-booking-id">Booking ID</label>
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
                      start: (fd.get('start') as string) || undefined,
                      end: (fd.get('end') as string) || undefined,
                      staffId: (fd.get('staffId') as string) || undefined,
                      serviceId: (fd.get('serviceId') as string) || undefined,
                    }),
                  setBookingResult,
                );
              }}
            >
              <div className="two-col">
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-booking-id-2">Booking ID</label>
                  <input
                    id="bk-booking-id-2"
                    name="bookingId"
                    className="form-input"
                    placeholder="ID to update"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-title">New Title</label>
                  <input
                    id="bk-new-title"
                    name="title"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-start">New Start</label>
                  <input
                    id="bk-new-start"
                    name="start"
                    className="form-input"
                    placeholder="Optional RFC3339"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-end">New End</label>
                  <input
                    id="bk-new-end"
                    name="end"
                    className="form-input"
                    placeholder="Optional RFC3339"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-staff-id">New Staff ID</label>
                  <input
                    id="bk-new-staff-id"
                    name="staffId"
                    className="form-input"
                    placeholder="Optional"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-new-service-id">New Service ID</label>
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
                  <label className="form-label" htmlFor="bk-booking-id-3">Booking ID</label>
                  <input
                    id="bk-booking-id-3"
                    name="bookingId"
                    className="form-input"
                    placeholder="ID to cancel"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-reason">Reason</label>
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
                      start: fd.get('start') as string,
                      end: fd.get('end') as string,
                      limit: (fd.get('limit') as string) ? Number(fd.get('limit')) : undefined,
                      pageToken: (fd.get('pageToken') as string) || undefined,
                    }),
                  setBookingResult,
                );
              }}
            >
              <div className="two-col">
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-start-rfc3339-2">Start (RFC3339)</label>
                  <input
                    id="bk-start-rfc3339-2"
                    name="start"
                    className="form-input"
                    defaultValue={defaultRange.start}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-end-rfc3339-2">End (RFC3339)</label>
                  <input
                    id="bk-end-rfc3339-2"
                    name="end"
                    className="form-input"
                    defaultValue={defaultRange.end}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-limit">Limit</label>
                  <input
                    id="bk-limit"
                    name="limit"
                    className="form-input"
                    placeholder="Optional page size"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="bk-page-token">Page Token</label>
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
