'use client';

import { useState, type ReactNode } from 'react';
import ApiHint from '../../ApiHint';

/** The row of controls above a roster: search, an optional filter, and the
 *  primary "add" action on the right. */
export function RosterToolbar({
  search,
  onSearch,
  searchLabel,
  filter,
  action,
}: {
  search: string;
  onSearch: (v: string) => void;
  searchLabel: string;
  filter?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="roster-toolbar">
      <input
        type="search"
        className="form-input roster-search"
        placeholder={searchLabel}
        aria-label={searchLabel}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      {filter}
      {action ? <div className="roster-toolbar-action">{action}</div> : null}
    </div>
  );
}

/**
 * Open one record by its provider ID: the get-by-id call, then its row opens
 * with everything else (edit, status, delete) in one place. Works before the
 * list is loaded, so a known ID never needs a full list read first.
 */
export function OpenById({
  what,
  busy,
  onOpen,
  call,
}: {
  what: string;
  busy: boolean;
  onOpen: (id: string) => void;
  /** The get-by-id call it makes, shown as a hint. */
  call?: string;
}) {
  const [id, setId] = useState('');
  const inputId = `open-${what.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <form
      className="roster-open"
      aria-label={`Open ${what} by ID`}
      onSubmit={(e) => {
        e.preventDefault();
        if (id.trim()) onOpen(id.trim());
      }}
    >
      <label className="form-label" htmlFor={inputId}>
        {what} ID
      </label>
      <div className="roster-open-row">
        <input
          id={inputId}
          className="form-input"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="Paste an ID to view, edit or delete it"
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !id.trim()}>
          Open
        </button>
      </div>
      {call ? <ApiHint call={call} /> : null}
    </form>
  );
}

/** Scroll an opened row's editor into view once it has rendered. */
export function reveal(elementId: string) {
  setTimeout(() => {
    document.getElementById(elementId)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, 60);
}

/** Before a real account's list is read: one clear call to action. */
export function LoadPrompt({
  what,
  provider,
  busy,
  onLoad,
  call,
}: {
  what: string;
  provider: string;
  busy: boolean;
  onLoad: () => void;
  /** The list call it makes, shown as a hint. */
  call?: string;
}) {
  return (
    <div className="roster-empty">
      <p>
        Load the {what} from your {provider} account to view and edit them here.
      </p>
      <button type="button" className="btn btn-primary" onClick={onLoad} disabled={busy}>
        {busy ? 'Loading…' : `Load ${what}`}
      </button>
      {call ? <ApiHint call={call} /> : null}
    </div>
  );
}

/** A provider id, set in mono because it is data to copy into other tabs. */
export function IdLine({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="roster-id">
      <span className="form-label">ID</span>
      <code className="rb-mono">{id}</code>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Who performs a service / what a staff member performs, as ticks. Each
 *  tick is a live assign or unassign call. */
export function AssignChecklist({
  legend,
  items,
  editable,
  busy,
  onToggle,
  emptyText,
  call,
}: {
  /** The assign/unassign call a tick makes, shown as a hint. */
  call?: string;
  legend: string;
  items: { id: string; name: string; inactive?: boolean; checked: boolean | undefined }[];
  editable: boolean;
  busy: boolean;
  onToggle: (id: string, next: boolean) => void;
  emptyText: string;
}) {
  return (
    <fieldset className="roster-assign">
      <legend className="form-label">{legend}</legend>
      {items.length === 0 ? (
        <p className="cal-muted">{emptyText}</p>
      ) : (
        <div className="roster-assign-grid">
          {items.map((it) => (
            <label key={it.id} className={`roster-check ${it.inactive ? 'is-inactive' : ''}`}>
              <input
                type="checkbox"
                checked={it.checked === true}
                disabled={!editable || busy}
                onChange={(e) => onToggle(it.id, e.target.checked)}
              />
              <span>
                {it.name}
                {it.inactive ? <span className="roster-aside"> (inactive)</span> : null}
              </span>
            </label>
          ))}
        </div>
      )}
      {editable && call ? <ApiHint call={call} /> : null}
      {!editable ? (
        <p className="cal-muted roster-note">This provider reports who performs what, but it can&apos;t be changed through its API.</p>
      ) : null}
    </fieldset>
  );
}

/** A labelled text/number input with no hidden constraints. */
export function Field({
  id,
  label,
  name,
  defaultValue,
  placeholder,
  required,
  type = 'text',
  step,
  min,
  hint,
}: {
  id: string;
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
  step?: string;
  min?: string;
  hint?: string;
}) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        className="form-input"
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        step={step}
        min={min}
      />
      {hint ? <span className="form-hint">{hint}</span> : null}
    </div>
  );
}

/** Active / inactive, saved with the rest of the form (`update*({ active })`). */
export function StatusField({ id, active }: { id: string; active: boolean }) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        Status
      </label>
      <select id={id} name="status" className="form-select" defaultValue={active ? 'active' : 'inactive'}>
        <option value="active">Active (bookable)</option>
        <option value="inactive">Inactive (not bookable)</option>
      </select>
    </div>
  );
}

/** The trimmed, non-empty text fields of a submitted form. */
export function fieldsOf(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((v, k) => {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
  });
  return out;
}

/** Only the fields that differ from what is stored, so an edit never rewrites
 *  a value the visitor did not touch. */
export function changed(
  fields: Record<string, string>,
  current: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (current[k] !== v) out[k] = v;
  }
  return out;
}

/** What this provider can't do here, in one quiet line. */
export function Limits({ provider, items }: { provider: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p className="cal-muted roster-limits">
      {provider} can&apos;t {items.join(', or ')} through its API.
    </p>
  );
}
