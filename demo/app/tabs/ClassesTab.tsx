'use client';

import { useState } from 'react';
import {
  type ActionResult,
  type Connection,
  callEnrollInClass,
  callListClasses,
  providerCapabilities,
} from '../../lib/call';
import type { ProviderMeta } from '../../lib/providers';
import ResultBox from '../ResultBox';
import PersistedForm from '../PersistedForm';

export type ClassesTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  defaultRange: { start: string; end: string };
  classesResult: ActionResult | null;
  setClassesResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  elapsedMs?: number;
};

/** A ClassSession as it arrives over the wire. */
type ClassRow = {
  id: string;
  title: string;
  range: { start: string; end: string };
  capacity?: number;
  booked?: number;
  available?: number;
  full: boolean;
  status: string;
  waitlistCapacity?: number;
  waitlistCount?: number;
};

/** Pull the class list out of the last result, when that result was a
 *  successful listClasses. Anything else yields none, so an enroll result does
 *  not blank or corrupt the picker. */
function classesOf(result: ActionResult | null): ClassRow[] {
  if (!result?.ok) return [];
  const data = result.data as { classes?: unknown } | null | undefined;
  return Array.isArray(data?.classes) ? (data.classes as ClassRow[]) : [];
}

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** The badge a class gets. `full` is authoritative and can disagree with the
 *  numbers — a provider may close a class while spots remain — so it wins. */
function badgeFor(k: ClassRow): { text: string; tone: string } {
  if (k.status === 'cancelled') return { text: 'cancelled', tone: 'badge-danger' };
  if (k.status === 'completed') return { text: 'finished', tone: 'badge-muted' };
  if (k.full) {
    const room = (k.waitlistCapacity ?? 0) - (k.waitlistCount ?? 0);
    return room > 0
      ? { text: 'waitlist', tone: 'badge-warn' }
      : { text: 'full', tone: 'badge-danger' };
  }
  if (k.capacity !== undefined && k.booked !== undefined) {
    return { text: `${k.booked}/${k.capacity}`, tone: 'badge-ok' };
  }
  return { text: 'open', tone: 'badge-ok' };
}

export default function ClassesTab({
  selectedProvider,
  providerInfo,
  conn,
  defaultRange,
  classesResult,
  setClassesResult,
  wrap,
  busy,
  elapsedMs,
}: ClassesTabProps) {
  const [selectedClass, setSelectedClass] = useState('');
  const classes = classesOf(classesResult);
  const caps = selectedProvider ? providerCapabilities(selectedProvider) : null;
  const supported = caps?.classCatalog === true;

  if (!selectedProvider) {
    return (
      <div className="fade-in">
        <div className="empty-state">
          <span className="icon">🧘</span>
          Select a provider in the Connect tab first
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title">
          <span className="icon">🧘</span> Group Classes — {providerInfo?.label}
        </div>

        {!supported ? (
          <div className="empty-state">
            <span className="icon">🚫</span>
            <div>
              <strong>{providerInfo?.label}</strong> has no group-class concept.
              <p
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '0.82rem',
                  marginTop: '0.5rem',
                }}
              >
                Classes need <code>capabilities.classCatalog</code>. Plain calendars have events,
                which carry no capacity or enrollment. Try <strong>Mindbody</strong> or{' '}
                <strong>Acuity</strong>.
              </p>
            </div>
          </div>
        ) : (
          <>
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: '0.82rem',
                marginBottom: '1rem',
              }}
            >
              A <code>ClassSession</code> is one scheduled occurrence with capacity. Enrolling
              returns an ordinary <code>Booking</code> carrying <code>classId</code>, so cancelling
              it is just <code>cancelBooking()</code> on the Bookings tab.
            </p>

            <PersistedForm
              formKey="classes:list"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const str = (k: string): string => ((fd.get(k) as string) ?? '').trim();
                wrap(
                  'classes',
                  () =>
                    callListClasses(selectedProvider, conn, {
                      start: str('start') || defaultRange.start,
                      end: str('end') || defaultRange.end,
                      ...(str('staffId') ? { staffId: str('staffId') } : {}),
                      ...(str('serviceId') ? { serviceId: str('serviceId') } : {}),
                      limit: 50,
                    }),
                  setClassesResult,
                );
              }}
            >
              <div className="form-group">
                <label className="form-label" htmlFor="cl-start">
                  From
                </label>
                <input id="cl-start" name="start" type="datetime-local" className="form-input" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cl-end">
                  To
                </label>
                <input id="cl-end" name="end" type="datetime-local" className="form-input" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cl-staff">
                  Instructor ID <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
                </label>
                <input id="cl-staff" name="staffId" type="text" className="form-input" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cl-service">
                  Class type ID <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
                </label>
                <input id="cl-service" name="serviceId" type="text" className="form-input" />
              </div>
              <div className="op-row">
                <button className="btn btn-sm btn-primary" disabled={busy('classes')} type="submit">
                  🔍 List Classes
                </button>
              </div>
            </PersistedForm>

            {classes.length > 0 && (
              <div style={{ marginTop: '1.25rem' }}>
                <div className="form-label">
                  {classes.length} class{classes.length === 1 ? '' : 'es'} — pick one to enroll
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
                  {classes.map((k) => {
                    const badge = badgeFor(k);
                    return (
                      <li key={k.id} style={{ marginBottom: '0.35rem' }}>
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.6rem',
                            padding: '0.5rem 0.65rem',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            background:
                              selectedClass === k.id ? 'var(--surface-2, #0002)' : 'transparent',
                          }}
                        >
                          <input
                            type="radio"
                            name="classPick"
                            value={k.id}
                            checked={selectedClass === k.id}
                            onChange={() => setSelectedClass(k.id)}
                          />
                          <span style={{ fontWeight: 600 }}>{k.title}</span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                            {when(k.range.start)}
                          </span>
                          <span className={`badge ${badge.tone}`} style={{ marginLeft: 'auto' }}>
                            {badge.text}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div style={{ marginTop: '1.5rem' }}>
              <div className="form-label">Enroll a customer</div>
              <PersistedForm
                formKey="classes:enroll"
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const str = (k: string): string => ((fd.get(k) as string) ?? '').trim();
                  wrap(
                    'classes',
                    () =>
                      callEnrollInClass(selectedProvider, conn, {
                        // The picker wins when something is selected; the field
                        // is the escape hatch for an id from elsewhere.
                        classId: selectedClass || str('classId'),
                        ...(str('customerId') ? { customerId: str('customerId') } : {}),
                        ...(str('customerName') ? { customerName: str('customerName') } : {}),
                        ...(str('customerEmail') ? { customerEmail: str('customerEmail') } : {}),
                        ...(fd.get('allowWaitlist') ? { allowWaitlist: true } : {}),
                      }),
                    setClassesResult,
                  );
                }}
              >
                <div className="form-group">
                  <label className="form-label" htmlFor="cl-id">
                    Class ID
                  </label>
                  <input
                    id="cl-id"
                    name="classId"
                    type="text"
                    className="form-input"
                    placeholder={selectedClass || 'pick one above, or paste an id'}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cl-cust-id">
                    Customer ID
                  </label>
                  <input
                    id="cl-cust-id"
                    name="customerId"
                    type="text"
                    className="form-input"
                    placeholder="provider-side client id"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cl-cust-name">
                    Customer name
                  </label>
                  <input id="cl-cust-name" name="customerName" type="text" className="form-input" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cl-cust-email">
                    Customer email
                  </label>
                  <input
                    id="cl-cust-email"
                    name="customerEmail"
                    type="email"
                    className="form-input"
                  />
                </div>
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" name="allowWaitlist" value="1" />
                    <span>
                      Join the waitlist if full
                      {caps?.classWaitlist === false && (
                        <em style={{ color: 'var(--text-muted)' }}>
                          {' '}
                          — {providerInfo?.label} has no waitlist, so a full class still conflicts
                        </em>
                      )}
                    </span>
                  </label>
                </div>
                <div className="op-row">
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy('classes')}
                    type="submit"
                  >
                    ✍️ Enroll
                  </button>
                </div>
              </PersistedForm>
            </div>

            <p
              style={{
                color: 'var(--text-muted)',
                fontSize: '0.78rem',
                marginTop: '1rem',
              }}
            >
              A full, cancelled or finished class throws <code>CONFLICT</code> before anything is
              written — the capacity check runs here, not after the provider rejects the write.
            </p>
          </>
        )}

        {classesResult && (
          <ResultBox result={classesResult} label="classes result" elapsedMs={elapsedMs} />
        )}
      </div>
    </div>
  );
}
