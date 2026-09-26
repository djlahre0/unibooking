'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Calendar } from 'unibooking';
import { callOp, providerCapabilities, type Connection } from '../../lib/call';
import type { ProviderMeta } from '../../lib/providers';
import { browserZone, toInstant } from '../../lib/datetime';
import { shiftDate, todayIn } from '../../lib/calendar/agenda';
import { loadRecords, type UbRecord } from '../../lib/record-sync';
import {
  addBooking,
  changeBooking,
  deleteBooking,
  linksFor,
  loadProject,
  saveProject,
  seedDemoProject,
  withLinks,
  type CalendarLinks,
  type Project,
  type ProjectBooking,
} from '../../lib/project';
import {
  calendarFor,
  syncProjectCalendars,
  type ProjectSyncReport,
  type Reach,
} from '../../lib/project-calendar-sync';
import ApiHint from '../ApiHint';

export type CalendarSyncTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
};

/** The calendar field a provider's pasted credentials use to pick one. */
const CAL_FIELD: Record<string, string> = {
  google: 'calendarId',
  outlook: 'calendarId',
  apple: 'calendarUrl',
};

const when = (iso: string, tz: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  });

export default function CalendarSyncTab({
  selectedProvider: P,
  providerInfo,
  conn,
}: CalendarSyncTabProps) {
  const caps = P ? providerCapabilities(P) : null;
  const label = providerInfo?.label ?? P;
  const tz = browserZone();
  const [project, setProjectState] = useState<Project>(() => loadProject());
  const [records, setRecords] = useState(() => loadRecords());
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [report, setReport] = useState<ProjectSyncReport | null>(null);
  const [adding, setAdding] = useState(false);

  const nameOf = useMemo(() => {
    const m = new Map(records.records.map((r) => [r.id, r.name]));
    return (id?: string) => (id ? (m.get(id) ?? id) : '');
  }, [records]);

  if (!P) {
    return (
      <div className="fade-in">
        <div className="empty-state">Choose Google Calendar, Outlook or Apple in the sidebar to start.</div>
      </div>
    );
  }
  // Only the selected provider, and only if it has calendars. A booking
  // platform's staff and services are linked in the Mapping tab instead.
  if (!caps?.calendarList) {
    return (
      <div className="fade-in">
        <div className="card">
          <div className="card-title">Calendar Sync</div>
          <p className="cal-muted">
            {label} has no calendars. Calendar Sync links your project to one calendar provider at
            a time: choose Google Calendar, Outlook or Apple in the sidebar. To link your
            project&apos;s staff and services to {label}, use the Mapping tab.
          </p>
        </div>
      </div>
    );
  }

  const setProject = (p: Project) => {
    setProjectState(p);
    saveProject(p);
  };
  const links = linksFor(project, P);
  const staff = records.records.filter((r) => r.kind === 'staff');
  const services = records.records.filter((r) => r.kind === 'services');
  const calName = (id?: string) =>
    calendars?.find((c) => c.id === id)?.name ?? (id ? 'a calendar' : '');

  // Every call goes to the selected provider only: its sign-in session, or
  // its pasted credentials with the calendar folded in.
  const reach: Reach = (calendarId) =>
    conn.signedIn
      ? { conn, args: { calendarId } }
      : {
          conn: { ...conn, creds: { ...conn.creds, [CAL_FIELD[P] ?? 'calendarId']: calendarId } },
          args: {},
        };

  const range = {
    start: toInstant(shiftDate(todayIn(tz), -1), '00:00', tz),
    end: toInstant(shiftDate(todayIn(tz), 60), '00:00', tz),
  };

  async function loadCalendars() {
    setBusy('calendars');
    setProblem('');
    try {
      const r = await callOp(P, conn, 'listCalendars', {});
      if (r.ok) setCalendars((r.data as { calendars: Calendar[] }).calendars);
      else setProblem(r.error?.message ?? 'Could not read calendars.');
    } finally {
      setBusy('');
    }
  }

  async function sync(p: Project = project) {
    setBusy('sync');
    setProblem('');
    try {
      const out = await syncProjectCalendars({
        provider: P,
        bookings: p.bookings,
        links: linksFor(p, P),
        range,
        titleOf: (b) =>
          `${nameOf(b.serviceId) || 'Booking'}${b.customer ? ` · ${b.customer}` : ''}`,
        describe: (b) =>
          [
            'Booked in your project (via unibooking).',
            b.staffId ? `Staff: ${nameOf(b.staffId)}` : '',
            b.serviceId ? `Service: ${nameOf(b.serviceId)}` : '',
            b.customer ? `Customer: ${b.customer}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        call: callOp,
        reach,
      });
      setProject(withLinks({ ...p, bookings: out.bookings }, P, out.links));
      setReport(out.report);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  /** Save a project change, then push it straight to the calendar when any
   *  calendar is linked: a booking made in the project shows up there. */
  const commit = (p: Project) => {
    setProject(p);
    const l = linksFor(p, P);
    if (l.all || Object.keys(l.staff).length || Object.keys(l.services).length) void sync(p);
  };

  const setLink = (kind: 'staff' | 'services' | 'all', id: string, calendarId: string) => {
    const next: CalendarLinks = {
      ...links,
      staff: { ...links.staff },
      services: { ...links.services },
    };
    if (kind === 'all') {
      if (calendarId) next.all = calendarId;
      else delete next.all;
    } else if (calendarId) next[kind][id] = calendarId;
    else delete next[kind][id];
    setProject(withLinks(project, P, next));
  };

  const writable = (calendars ?? []).filter((c) => !c.readOnly);
  const upcoming = project.bookings
    .filter((b) => Date.parse(b.end) > Date.parse(range.start))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const linkedCount =
    (links.all ? 1 : 0) + Object.keys(links.staff).length + Object.keys(links.services).length;

  const statusOf = (b: ProjectBooking): { text: string; tone: string } => {
    if (b.status === 'cancelled') return { text: 'Cancelled', tone: 'inkfaint' };
    const target = calendarFor(links, b);
    const copy = links.copies[b.id];
    if (!target) return { text: 'No calendar linked', tone: 'inkfaint' };
    if (!copy) return { text: 'Not in calendar yet', tone: 'amber' };
    if (copy.calendarId !== target) return { text: 'Moving calendars', tone: 'amber' };
    const same =
      Date.parse(copy.start) === Date.parse(b.start) && Date.parse(copy.end) === Date.parse(b.end);
    return same
      ? { text: `In ${calName(copy.calendarId)}`, tone: 'pine' }
      : { text: 'Changed, not synced', tone: 'amber' };
  };

  const picker = (value: string | undefined, onChange: (v: string) => void, aria: string) => (
    <select
      className="form-select map-link-select"
      aria-label={aria}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={!calendars || !!busy}
    >
      <option value="">{calendars ? 'No calendar' : 'Load calendars first'}</option>
      {writable.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
      {value && calendars && !writable.some((c) => c.id === value) ? (
        <option value={value}>{calName(value)} (not found)</option>
      ) : null}
    </select>
  );

  const addForm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? '').trim();
    const svc = services.find((s) => s.id === get('serviceId'));
    const start = toInstant(get('date'), get('time'), tz);
    if (!start || !svc) return;
    const end = new Date(Date.parse(start) + (svc.durationMinutes ?? 30) * 60_000).toISOString();
    setAdding(false);
    commit(
      addBooking(project, {
        start,
        end,
        serviceId: svc.id,
        ...(get('staffId') ? { staffId: get('staffId') } : {}),
        ...(get('customer') ? { customer: get('customer') } : {}),
      }),
    );
  };

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title roster-title">
          <span>Calendar Sync</span>
          <span className="roster-count">your project ↔ {label}</span>
        </div>
        <p className="cal-muted map-intro">
          Link your project&apos;s staff and services to {label} calendars. Every booking made in
          your project then appears in its calendar, and changes follow it both ways. Only {label}{' '}
          is used here: nothing is copied to or from any other provider.
        </p>

        {records.records.length === 0 ? (
          <div className="conn-verdict conn-verdict-warn" role="note">
            <div className="conn-verdict-title">Your project is empty</div>
            <p className="conn-verdict-detail">
              Load a small demo salon (3 staff, 4 services, a week of bookings) to try this out.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                const seeded = seedDemoProject(tz);
                setRecords(seeded.records);
                setProjectState(seeded.project);
              }}
            >
              Load demo salon
            </button>
          </div>
        ) : null}

        <div className="map-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadCalendars()}
            disabled={!!busy}
          >
            {busy === 'calendars'
              ? 'Loading…'
              : calendars
                ? `Reload ${label} calendars`
                : `Load ${label} calendars`}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void sync()}
            disabled={!!busy || linkedCount === 0 || !calendars}
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        <ApiHint call="client.listCalendars() · client.listBookings({ range }) · createBooking / updateBooking / cancelBooking">
          Sync reads the linked calendars and keeps one event per project booking.
        </ApiHint>
        {problem ? (
          <p className="roster-problem" role="alert">
            {problem}
          </p>
        ) : null}

        <div className="map-sides">
          <section className="map-side" aria-label="Your project">
            <div className="map-side-head">
              <h3>Your project</h3>
              <span className="roster-count">{linkedCount} linked</span>
            </div>
            <div className="form-group">
              <span className="form-label">All bookings (when no staff or service link applies)</span>
              {picker(links.all, (v) => setLink('all', '', v), 'Calendar for all bookings')}
            </div>
            <LinkGroup
              title="Staff"
              rows={staff}
              render={(r) =>
                picker(links.staff[r.id], (v) => setLink('staff', r.id, v), `Calendar for ${r.name}`)
              }
            />
            <LinkGroup
              title="Services"
              rows={services}
              render={(r) =>
                picker(
                  links.services[r.id],
                  (v) => setLink('services', r.id, v),
                  `Calendar for ${r.name}`,
                )
              }
            />
            <p className="cal-muted map-empty">
              A booking goes to its staff member&apos;s calendar, else its service&apos;s, else
              &ldquo;All bookings&rdquo;.
            </p>
          </section>

          <section className="map-side" aria-label={`${label} calendars`}>
            <div className="map-side-head">
              <h3>{label} calendars</h3>
              {calendars ? <span className="roster-count">{calendars.length}</span> : null}
            </div>
            {!calendars ? (
              <p className="cal-muted map-empty">Load {label} calendars to link them.</p>
            ) : (
              <ul className="map-list">
                {calendars.map((c) => {
                  const who = [
                    ...Object.entries(links.staff)
                      .filter(([, id]) => id === c.id)
                      .map(([k]) => nameOf(k)),
                    ...Object.entries(links.services)
                      .filter(([, id]) => id === c.id)
                      .map(([k]) => nameOf(k)),
                    ...(links.all === c.id ? ['All bookings'] : []),
                  ];
                  const copies = Object.values(links.copies).filter(
                    (x) => x.calendarId === c.id,
                  ).length;
                  return (
                    <li key={c.id} className="map-row">
                      <div className="map-row-main">
                        <span className="map-name">
                          <span
                            className="cal-dot"
                            style={{ background: c.color ?? 'var(--accent)' }}
                            aria-hidden="true"
                          />{' '}
                          {c.name}
                        </span>
                        <span className="map-detail">
                          {c.readOnly
                            ? 'Read-only'
                            : copies
                              ? `${copies} booking${copies === 1 ? '' : 's'} from your project`
                              : 'No project bookings yet'}
                        </span>
                      </div>
                      <span className={`rb-status rb-status-${who.length ? 'pine' : 'inkfaint'}`}>
                        {who.length ? 'Linked' : 'Not linked'}
                      </span>
                      {who.length ? <span className="map-partner">← {who.join(', ')}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <ApiHint call="client.listCalendars()">Only {label}&apos;s calendars are listed.</ApiHint>
          </section>
        </div>

        <section className="cs-bookings" aria-label="Project bookings">
          <div className="map-side-head">
            <h3>Bookings in your project</h3>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setAdding((a) => !a)}
              disabled={services.length === 0}
              aria-expanded={adding}
            >
              {adding ? 'Close' : 'New booking'}
            </button>
          </div>
          {adding ? (
            <form className="cs-new" onSubmit={addForm} aria-label="New project booking">
              <div className="roster-form-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="cs-new-service">
                    Service
                  </label>
                  <select id="cs-new-service" name="serviceId" className="form-select" required>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cs-new-staff">
                    Staff
                  </label>
                  <select id="cs-new-staff" name="staffId" className="form-select">
                    <option value="">Anyone</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cs-new-date">
                    Date
                  </label>
                  <input
                    id="cs-new-date"
                    name="date"
                    type="date"
                    className="form-input"
                    required
                    defaultValue={shiftDate(todayIn(tz), 1)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cs-new-time">
                    Time
                  </label>
                  <input
                    id="cs-new-time"
                    name="time"
                    type="time"
                    className="form-input"
                    required
                    defaultValue="10:00"
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cs-new-customer">
                  Customer
                </label>
                <input
                  id="cs-new-customer"
                  name="customer"
                  className="form-input"
                  placeholder="Optional"
                />
              </div>
              <button type="submit" className="btn btn-primary btn-sm">
                Book in project
              </button>
              <ApiHint call="client.createBooking({ title, range, description })">
                Written to the linked {label} calendar straight away.
              </ApiHint>
            </form>
          ) : null}

          {upcoming.length === 0 ? (
            <p className="cal-muted map-empty">No upcoming bookings in your project.</p>
          ) : (
            <ul className="map-list">
              {upcoming.map((b) => {
                const st = statusOf(b);
                return (
                  <li key={b.id} className="map-row">
                    <div className="map-row-main">
                      <span className="map-name">
                        {nameOf(b.serviceId) || 'Booking'}
                        {b.customer ? ` · ${b.customer}` : ''}
                      </span>
                      <span className="map-detail">
                        {when(b.start, tz)}
                        {b.staffId ? ` with ${nameOf(b.staffId)}` : ''}
                      </span>
                    </div>
                    <span className={`rb-status rb-status-${st.tone}`}>{st.text}</span>
                    {b.status !== 'cancelled' ? (
                      <div className="map-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!!busy}
                          onClick={() => {
                            const start = new Date(Date.parse(b.start) + 3_600_000).toISOString();
                            const end = new Date(Date.parse(b.end) + 3_600_000).toISOString();
                            commit(changeBooking(project, b.id, { start, end }));
                          }}
                        >
                          Move 1 hour later
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!!busy}
                          onClick={() =>
                            commit(changeBooking(project, b.id, { status: 'cancelled' }))
                          }
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm cal-danger"
                          disabled={!!busy}
                          onClick={() => {
                            if (window.confirm('Delete this booking from your project?')) {
                              commit(deleteBooking(project, b.id));
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {links.busy.length ? (
          <section className="cs-bookings" aria-label={`Busy time from ${label}`}>
            <div className="map-side-head">
              <h3>Busy in {label}</h3>
              <span className="roster-count">{links.busy.length}</span>
            </div>
            <p className="cal-muted map-empty">
              Other events in the linked calendars. Your project treats this time as taken.
            </p>
            <ul className="map-list">
              {links.busy.map((x) => (
                <li key={`${x.calendarId}:${x.eventId}`} className="map-row">
                  <div className="map-row-main">
                    <span className="map-name">{x.title || 'Busy'}</span>
                    <span className="map-detail">
                      {when(x.start, tz)} · {calName(x.calendarId)}
                    </span>
                  </div>
                  <span className="rb-status rb-status-inkfaint">Busy</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {report ? <SyncSummary report={report} provider={label} /> : null}
      </div>
    </div>
  );
}

function LinkGroup({
  title,
  rows,
  render,
}: {
  title: string;
  rows: UbRecord[];
  render: (r: UbRecord) => ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="cs-group">
      <h4 className="provider-group-title">{title}</h4>
      {rows.map((r) => (
        <div key={r.id} className="sync-link-row">
          <span>{r.name}</span>
          {render(r)}
        </div>
      ))}
    </div>
  );
}

function SyncSummary({ report, provider }: { report: ProjectSyncReport; provider: string }) {
  const parts = [
    report.created && `${report.created} added to ${provider}`,
    report.updated && `${report.updated} updated`,
    report.moved && `${report.moved} moved to another calendar`,
    report.removed && `${report.removed} removed`,
    report.pulled && `${report.pulled} moved in ${provider}, updated in your project`,
    report.unchanged && `${report.unchanged} already in step`,
    report.unlinked && `${report.unlinked} with no calendar linked`,
    report.busy && `${report.busy} busy events read back`,
  ].filter(Boolean);
  const ok = report.errors.length === 0;
  return (
    <div className={`conn-verdict conn-verdict-${ok ? 'ok' : 'bad'}`} role="status">
      <div className="conn-verdict-title">{ok ? 'Synced' : 'Synced, with problems'}</div>
      <p className="conn-verdict-detail">{parts.length ? parts.join(' · ') : 'Nothing to do.'}</p>
      {report.errors.length ? (
        <ul className="conn-verdict-hints">
          {report.errors.map((e, i) => (
            <li key={i}>
              {e.bookingId}: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
