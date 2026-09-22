'use client';

import { instantToZoned, type Booking } from 'unibooking';
import { dayLabel, shiftDate } from '../../lib/calendar/agenda';

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
  onDelete,
  onClose,
}: {
  booking: Booking;
  displayTz: string;
  readOnly: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ownZone = booking.range.timezone;
  return (
    <div className="card cal-details" role="dialog" aria-label={`Event: ${booking.title}`}>
      <div className="card-title">
        <span className="icon">📌</span> {booking.title}
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
        <dt>Status</dt>
        <dd>{booking.status}</dd>
      </dl>
      <div className="op-row">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={onEdit}
          disabled={readOnly || busy}
        >
          ✏️ Edit
        </button>
        <button
          className="btn btn-secondary btn-sm cal-danger"
          type="button"
          onClick={onDelete}
          disabled={readOnly || busy}
        >
          🗑 Delete
        </button>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {readOnly ? <p className="cal-muted">This calendar is read-only for your account.</p> : null}
    </div>
  );
}
