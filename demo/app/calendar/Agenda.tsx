'use client';

import type { Booking } from 'unibooking';
import type { AgendaDay, WindowDays } from '../../lib/calendar/agenda';
import { MAX_EVENTS_NOTICE } from './constants';
import TimezoneField from './TimezoneField';
import ApiHint from '../ApiHint';
import { CalendarIcon, PinIcon } from '../components/icons';

export default function Agenda({
  days,
  loading,
  truncated,
  windowDays,
  displayTz,
  rangeLabel,
  readOnly,
  onPrev,
  onToday,
  onNext,
  onWindowDays,
  onDisplayTz,
  onNew,
  onOpen,
}: {
  days: AgendaDay[];
  loading: boolean;
  truncated: boolean;
  windowDays: WindowDays;
  displayTz: string;
  rangeLabel: string;
  readOnly: boolean;
  onPrev: () => void;
  onToday: () => void;
  onNext: () => void;
  onWindowDays: (d: WindowDays) => void;
  onDisplayTz: (tz: string) => void;
  onNew: () => void;
  onOpen: (b: Booking) => void;
}) {
  return (
    <div className="cal-main">
      <div className="cal-toolbar">
        <div className="cal-toolbar-group">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={onPrev}
            aria-label="Previous"
          >
            ◀
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onToday}>
            Today
          </button>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={onNext}
            aria-label="Next"
          >
            ▶
          </button>
          <span className="cal-range">{rangeLabel}</span>
        </div>
        <div className="cal-toolbar-group">
          <select
            className="form-select cal-select"
            aria-label="Days shown"
            value={windowDays}
            onChange={(e) => onWindowDays(Number(e.target.value) as WindowDays)}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={onNew}
            disabled={readOnly}
            title={readOnly ? 'This calendar is read-only' : undefined}
          >
            + New event
          </button>
        </div>
      </div>
      <div className="cal-tz">
        <TimezoneField label="Display timezone" value={displayTz} onChange={onDisplayTz} />
      </div>
      <ApiHint call="listAll(client, { range: { start, end } })">
        Pages through client.listBookings for the whole window.
      </ApiHint>

      {loading ? <div className="loading">Loading events…</div> : null}
      {!loading && days.length === 0 ? (
        <div className="empty-state">
          <span className="icon">
            <CalendarIcon />
          </span>
          No events in this range.
        </div>
      ) : null}
      {!loading &&
        days.map((day) => (
          <section className="agenda-day" key={day.date} aria-label={day.label}>
            <h3 className="agenda-day-label">{day.label}</h3>
            {day.items.map((item) => (
              <button
                key={`${item.booking.id}-${day.date}`}
                type="button"
                className="agenda-row"
                onClick={() => onOpen(item.booking)}
              >
                <span className="agenda-time">{item.timeLabel}</span>
                <span className="agenda-title">{item.booking.title}</span>
                {item.booking.location ? (
                  <span className="agenda-location">
                    <PinIcon size={13} /> {item.booking.location}
                  </span>
                ) : null}
                {item.booking.status !== 'confirmed' ? (
                  <span className="info-badge warn">{item.booking.status}</span>
                ) : null}
              </button>
            ))}
          </section>
        ))}
      {truncated ? <p className="cal-muted">{MAX_EVENTS_NOTICE}</p> : null}
    </div>
  );
}
