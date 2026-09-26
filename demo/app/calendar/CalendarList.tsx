'use client';

import { useState } from 'react';
import type { Calendar } from 'unibooking';
import ApiHint from '../ApiHint';

export type CalendarActions = {
  create: (input: { name: string; color?: string }) => Promise<boolean>;
  rename: (calendar: Calendar, name: string) => Promise<boolean>;
  remove: (calendar: Calendar) => void;
};

export default function CalendarList({
  calendars,
  selectedId,
  loading,
  onSelect,
  busy = false,
  actions,
}: {
  calendars: Calendar[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  busy?: boolean;
  /** Present when the provider can make, rename and remove calendars. */
  actions?: CalendarActions;
}) {
  const [mode, setMode] = useState<'none' | 'new' | 'rename'>('none');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0f5c4a');
  const selected = calendars.find((c) => c.id === selectedId);
  const canChange = !!selected && !selected.readOnly;
  // The provider refuses to delete the account's own main calendar.
  const canDelete = canChange && !selected!.primary;

  const close = () => {
    setMode('none');
    setName('');
  };

  return (
    <div className="cal-sidebar">
      <div className="section-title">Calendars</div>
      {loading ? <div className="loading">Loading calendars…</div> : null}
      {!loading && calendars.length === 0 ? (
        <p className="cal-muted">No calendars found for this account.</p>
      ) : null}
      <div role="listbox" aria-label="Calendars">
        {calendars.map((c) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={c.id === selectedId}
            className={`cal-item ${c.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(c.id)}
            title={c.timezone ? `${c.name} · ${c.timezone}` : c.name}
          >
            <span
              className="cal-dot"
              style={{ background: c.color ?? 'var(--accent)' }}
              aria-hidden="true"
            />
            <span className="cal-item-name">{c.name}</span>
            {c.primary ? <span className="info-badge accent">primary</span> : null}
            {c.readOnly ? <span className="info-badge warn">read-only</span> : null}
          </button>
        ))}
      </div>
      <ApiHint call="client.listCalendars()" />

      {actions ? (
        <div className="cal-manage">
          <div className="cal-manage-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={mode === 'new'}
              onClick={() => (mode === 'new' ? close() : (setMode('new'), setName('')))}
              disabled={busy}
            >
              New calendar
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              aria-expanded={mode === 'rename'}
              onClick={() =>
                mode === 'rename' ? close() : (setMode('rename'), setName(selected?.name ?? ''))
              }
              disabled={busy || !canChange}
              title={canChange ? undefined : 'This calendar is read-only for your account'}
            >
              Rename
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm cal-danger"
              onClick={() => selected && actions.remove(selected)}
              disabled={busy || !canDelete}
              title={
                selected?.primary
                  ? "The account's main calendar can't be deleted"
                  : canChange
                    ? undefined
                    : 'This calendar is read-only for your account'
              }
            >
              Delete calendar
            </button>
          </div>

          {mode !== 'none' ? (
            <form
              className="cal-manage-form"
              aria-label={mode === 'new' ? 'New calendar' : 'Rename calendar'}
              onSubmit={async (e) => {
                e.preventDefault();
                const n = name.trim();
                if (!n) return;
                const ok =
                  mode === 'new'
                    ? await actions.create({ name: n, color })
                    : selected
                      ? await actions.rename(selected, n)
                      : false;
                if (ok) close();
              }}
            >
              <label className="form-label" htmlFor="cal-manage-name">
                {mode === 'new' ? 'Name' : 'New name'}
              </label>
              <div className="cal-manage-row">
                <input
                  id="cal-manage-name"
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Front desk"
                  required
                  autoFocus
                />
                {mode === 'new' ? (
                  <input
                    type="color"
                    aria-label="Colour"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                  />
                ) : null}
              </div>
              <div className="cal-manage-actions">
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
                  {mode === 'new' ? 'Create calendar' : 'Save name'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
                  Cancel
                </button>
              </div>
              {mode === 'new' ? (
                <ApiHint call="client.createCalendar({ name, color })" />
              ) : (
                <ApiHint call="client.updateCalendar(id, { name })" />
              )}
            </form>
          ) : (
            <ApiHint call="client.deleteCalendar(id)">Removes every event in it too.</ApiHint>
          )}
        </div>
      ) : null}
    </div>
  );
}
