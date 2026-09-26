'use client';

import { useState } from 'react';
import {
  changedInput,
  toEventInput,
  validate,
  type EventFormValues,
} from '../../lib/calendar/event-form';
import type { EventInput } from '../../lib/calendar/types';
import TimezoneField from './TimezoneField';
import ApiHint from '../ApiHint';

/**
 * Create / edit an event. The form speaks in dates, times and a timezone; the
 * pure helpers in lib/calendar/event-form.ts turn that into the canonical
 * instants unibooking takes. On edit only the changed fields are submitted.
 */
export default function EventForm({
  mode,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: 'new' | 'edit';
  initial: EventFormValues;
  busy: boolean;
  onSubmit: (input: EventInput) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<EventFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }));

  return (
    <form
      className="card cal-form"
      aria-label={mode === 'new' ? 'New event' : 'Edit event'}
      onSubmit={(e) => {
        e.preventDefault();
        const problem = validate(v);
        setError(problem);
        if (problem) return;
        onSubmit(mode === 'new' ? toEventInput(v) : changedInput(initial, v));
      }}
    >
      <div className="card-title">
        <span className="icon">{mode === 'new' ? '➕' : '✏️'}</span>
        {mode === 'new' ? 'New event' : 'Edit event'}
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="ev-title">
          Title
        </label>
        <input
          id="ev-title"
          className="form-input"
          value={v.title}
          placeholder="Team sync"
          onChange={(e) => set('title', e.target.value)}
        />
      </div>

      <label className="cal-check">
        <input
          type="checkbox"
          checked={v.allDay}
          onChange={(e) => set('allDay', e.target.checked)}
        />
        All-day event
      </label>

      <div className="two-col">
        <div className="form-group">
          <label className="form-label" htmlFor="ev-date">
            Start date
          </label>
          <input
            id="ev-date"
            className="form-input"
            type="date"
            value={v.date}
            onChange={(e) => set('date', e.target.value)}
          />
        </div>
        {v.allDay ? null : (
          <div className="form-group">
            <label className="form-label" htmlFor="ev-start">
              Start time
            </label>
            <input
              id="ev-start"
              className="form-input"
              type="time"
              value={v.startTime}
              onChange={(e) => set('startTime', e.target.value)}
            />
          </div>
        )}
        <div className="form-group">
          <label className="form-label" htmlFor="ev-end-date">
            End date
          </label>
          <input
            id="ev-end-date"
            className="form-input"
            type="date"
            value={v.endDate}
            onChange={(e) => set('endDate', e.target.value)}
          />
        </div>
        {v.allDay ? null : (
          <div className="form-group">
            <label className="form-label" htmlFor="ev-end">
              End time
            </label>
            <input
              id="ev-end"
              className="form-input"
              type="time"
              value={v.endTime}
              onChange={(e) => set('endTime', e.target.value)}
            />
          </div>
        )}
      </div>

      <TimezoneField label="Timezone" value={v.timezone} onChange={(tz) => set('timezone', tz)} />

      <div className="form-group">
        <label className="form-label" htmlFor="ev-location">
          Location
        </label>
        <input
          id="ev-location"
          className="form-input"
          value={v.location}
          placeholder="Optional"
          onChange={(e) => set('location', e.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="ev-description">
          Description
        </label>
        <textarea
          id="ev-description"
          className="form-textarea"
          rows={3}
          value={v.description}
          placeholder="Optional"
          onChange={(e) => set('description', e.target.value)}
        />
      </div>

      {error ? (
        <div className="cal-banner error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="op-row">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : mode === 'new' ? 'Create event' : 'Save changes'}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      <ApiHint
        call={
          mode === 'new'
            ? 'client.createBooking({ title, range, allDay, description, location })'
            : 'client.updateBooking(id, changedFields)'
        }
      >
        {mode === 'edit' ? 'Only the fields you changed are sent.' : null}
      </ApiHint>
    </form>
  );
}
