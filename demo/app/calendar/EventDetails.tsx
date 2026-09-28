'use client';

import { instantToZoned, type Booking } from 'unibooking';
import { dayLabel, shiftDate } from '../../lib/calendar/agenda';
import { EVENT_STATUS_LABELS, eventStatus, type EventStatus } from '../../lib/cancel-event';
import ApiHint from '../ApiHint';
import { PencilIcon, PinnedIcon, TrashIcon } from '../components/icons';

function when(b: Booking, tz: string): string {
  if (b.allDay) {
    const first = b.range.start.slice(0, 10);
    const last = shiftDate(b.range.end.slice(0, 10), -1);
    return last > first
      ? `All day, ${dayLabel(first)} – ${dayLabel(last)}`
      : `All day, ${dayLabel(first)}`;
  }
  try {
    const s = instantToZoned(b.range.start, tz);
    const e = instantToZoned(b.range.end, tz);
    const end = e.date === s.date ? e.time : `${dayLabel(e.date)} ${e.time}`;
    return `${dayLabel(s.date)}, ${s.time} – ${end} (${tz})`;
  } catch {
    return `${b.range.start} – ${b.range.end}`;
  }
}

export default function EventDetails({
  booking,
  displayTz,
  readOnly,
  busy,
  onEdit,
  onSetStatus,
  onDelete,
  onClose,
}: {
  booking: Booking;
  displayTz: string;
  readOnly: boolean;
  busy: boolean;
  onEdit: () => void;
  /** Confirmed / tentative / cancelled (kept, marked). Absent hides it. */
  onSetStatus?: (status: EventStatus) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ownZone = booking.range.timezone;
  const status = eventStatus(booking);
  return (
    <div className="card cal-details" role="dialog" aria-label={`Event: ${booking.title}`}>
      <div className="card-title">
        <span className="icon">
          <PinnedIcon size={18} />
        </span>{' '}
        {booking.title}
      </div>
      <dl className="cal-fields">
        <dt>When</dt>
        <dd>{when(booking, displayTz)}</dd>
        {!booking.allDay && ownZone && ownZone !== displayTz ? (
          <>
            <dt>Event timezone</dt>
            <dd>{when(booking, ownZone)}</dd>
          </>
        ) : null}
        {booking.location ? (
          <>
            <dt>Location</dt>
            <dd>{booking.location}</dd>
          </>
        ) : null}
        {booking.description ? (
          <>
            <dt>Description</dt>
            <dd className="cal-description">{booking.description}</dd>
          </>
        ) : null}
        {onSetStatus ? null : (
          <>
            <dt>Status</dt>
            <dd>{EVENT_STATUS_LABELS[status]}</dd>
          </>
        )}
      </dl>
      {onSetStatus ? (
        <div className="cal-status" role="group" aria-label="Status">
          <span className="form-label">Status</span>
          <div className="cal-status-options">
            {(Object.keys(EVENT_STATUS_LABELS) as EventStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`cal-status-option ${status === s ? 'is-current' : ''} cal-status-${s}`}
                aria-pressed={status === s}
                disabled={readOnly || busy}
                onClick={() => {
                  if (s !== status) onSetStatus(s);
                }}
              >
                {EVENT_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          <p className="cal-muted cal-status-help">
            {status === 'cancelled'
              ? 'Kept on the calendar, marked cancelled and not blocking the time. Pick Confirmed or Tentative to restore it.'
              : 'Cancelled keeps the event, marked cancelled and no longer blocking the time. Delete removes it for good.'}
          </p>
          <ApiHint call="client.updateBooking(id, { status })">
            Google and Outlook also get the title marker and free/busy change.
          </ApiHint>
        </div>
      ) : null}
      <div className="op-row">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={onEdit}
          disabled={readOnly || busy}
        >
          <PencilIcon /> Edit
        </button>
        <button
          className="btn btn-secondary btn-sm cal-danger"
          type="button"
          onClick={onDelete}
          disabled={readOnly || busy}
        >
          <TrashIcon /> Delete
        </button>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <ApiHint call="client.getBooking(id) · client.cancelBooking(id)">
        On a calendar, cancelBooking deletes the event.
      </ApiHint>
      {readOnly ? <p className="cal-muted">This calendar is read-only for your account.</p> : null}
    </div>
  );
}
