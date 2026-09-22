'use client';

import type { Calendar } from 'unibooking';

export default function CalendarList({
  calendars,
  selectedId,
  loading,
  onSelect,
}: {
  calendars: Calendar[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
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
    </div>
  );
}
