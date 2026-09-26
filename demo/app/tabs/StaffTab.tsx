'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { Service, Staff } from 'unibooking';
import {
  type ActionResult,
  type Connection,
  callAssignStaff,
  callCreateStaff,
  callDeleteStaff,
  callGetStaff,
  callUnassignStaff,
  callUpdateStaff,
  providerCapabilities,
} from '../../lib/call';
import { isLocal, type ProviderMeta } from '../../lib/providers';
import ResultBox from '../ResultBox';
import ApiHint from '../ApiHint';
import { performs, useRoster, type Wrap } from './catalog/useRoster';
import {
  AssignChecklist,
  changed,
  Field,
  fieldsOf,
  IdLine,
  Limits,
  LoadPrompt,
  OpenById,
  reveal,
  RosterToolbar,
  StatusField,
} from './catalog/parts';

export type StaffTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  result: ActionResult | null;
  setResult: (r: ActionResult | null) => void;
  wrap: Wrap;
  busy: (section: string) => boolean;
  elapsedMs?: number;
};

const SECTION = 'staff';

/** Providers that refuse a staff member without an email. */
const EMAIL_REQUIRED = new Set(['microsoft_bookings']);

export default function StaffTab(props: StaffTabProps) {
  const { selectedProvider: P, providerInfo, conn, result, setResult, wrap, busy, elapsedMs } =
    props;
  const caps = P ? providerCapabilities(P) : null;
  const label = providerInfo?.label ?? P;
  const roster = useRoster({
    provider: P,
    conn,
    caps,
    primary: 'staff',
    section: SECTION,
    wrap,
    setResult,
  });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const isBusy = busy(SECTION);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster.staff.filter(
      (m) =>
        (!q ||
          m.name.toLowerCase().includes(q) ||
          (m.email ?? '').toLowerCase().includes(q) ||
          m.id.toLowerCase() === q) &&
        (status === 'all' || (status === 'active') === m.active),
    );
  }, [roster.staff, search, status]);

  if (!P) {
    return (
      <div className="fade-in">
        <div className="empty-state">Select a provider in the Connect tab first.</div>
      </div>
    );
  }

  if (!caps?.staffDirectory) {
    return (
      <div className="fade-in">
        <div className="card">
          <div className="card-title">Staff</div>
          <p className="cal-muted">
            {label} has no staff directory to show. Staff come from booking platforms such as
            Square, Acuity or Microsoft Bookings; try the Sample Salon to see this tab working.
          </p>
        </div>
      </div>
    );
  }

  const canWrite = caps.staffDirectoryWrite;
  const canAssign = caps.staffServiceAssignmentWrite;
  const showsServices = caps.staffServiceAssignment && caps.serviceCatalog;
  const emailRequired = EMAIL_REQUIRED.has(P);
  const limits = [
    !canWrite && 'add or edit staff',
    canWrite && !caps.staffDeactivate && 'deactivate staff (delete them instead)',
    canWrite && !caps.staffDelete && 'delete staff (deactivate them instead)',
    showsServices && !canAssign && 'change which services someone performs',
  ].filter((x): x is string => !!x);

  const onSaved = (m: Staff) => {
    roster.upsertStaff(m);
    setOpen(m.id);
  };

  const remove = (m: Staff) => {
    if (!window.confirm(`Delete ${m.name} for good? This can't be undone.`)) return;
    void roster.act(
      () => callDeleteStaff(P, conn, m.id),
      () => {
        roster.dropStaff(m.id);
        setOpen(null);
      },
    );
  };

  const toggleService = (m: Staff, serviceId: string, next: boolean) => {
    void roster.act(
      () =>
        next ? callAssignStaff(P, conn, serviceId, m.id) : callUnassignStaff(P, conn, serviceId, m.id),
      (d) => {
        roster.upsertService(d as Service);
        // Keep a staff-side list in step too, where the provider reports one.
        if (m.serviceIds) {
          roster.upsertStaff({
            ...m,
            serviceIds: next
              ? [...new Set([...m.serviceIds, serviceId])]
              : m.serviceIds.filter((t) => t !== serviceId),
          });
        }
      },
    );
  };

  const lookUp = (id: string) => {
    void roster.act(
      () => callGetStaff(P, conn, id),
      (d) => {
        const m = d as Staff;
        roster.upsertStaff(m);
        setSearch('');
        setOpen(m.id);
        reveal(`stf-detail-${m.id}`);
      },
    );
  };

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title roster-title">
          <span>Staff</span>
          {roster.loaded ? (
            <span className="roster-count">
              {roster.staff.length}
              {roster.moreStaff ? '+' : ''} in {label}
            </span>
          ) : null}
          {roster.loaded ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm roster-reload"
              onClick={() => void roster.load()}
              disabled={isBusy}
            >
              Reload
            </button>
          ) : null}
        </div>

        {!isLocal(P) && canWrite ? (
          <p className="conn-verdict conn-verdict-warn roster-warning" role="note">
            Changes here are made in the real {label} account these credentials belong to. Use a
            sandbox or test account.
          </p>
        ) : null}
        <Limits provider={label} items={limits} />

        <OpenById what="Staff member" busy={isBusy} onOpen={lookUp} call="client.getStaff(id)" />

        {!roster.loaded && roster.staff.length === 0 ? (
          <LoadPrompt
            what="staff"
            provider={label}
            busy={isBusy}
            onLoad={() => void roster.load()}
            call="client.listStaff({ limit: 100 })"
          />
        ) : (
          <>
            <RosterToolbar
              search={search}
              onSearch={setSearch}
              searchLabel="Search staff by name, email or ID"
              filter={
                <select
                  className="form-select roster-filter"
                  aria-label="Status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as typeof status)}
                >
                  <option value="all">Active and inactive</option>
                  <option value="active">Active only</option>
                  <option value="inactive">Inactive only</option>
                </select>
              }
              action={
                canWrite ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    aria-expanded={adding}
                    onClick={() => setAdding((a) => !a)}
                  >
                    {adding ? 'Close' : 'Add staff member'}
                  </button>
                ) : null
              }
            />

            {adding ? (
              <div className="roster-new">
                <StaffForm
                  mode="create"
                  idBase="stf-new"
                  emailRequired={emailRequired}
                  busy={isBusy}
                  onCancel={() => setAdding(false)}
                  onSubmit={(input) =>
                    roster.act(
                      () => callCreateStaff(P, conn, input),
                      (d) => {
                        setAdding(false);
                        onSaved(d as Staff);
                      },
                    )
                  }
                />
              </div>
            ) : null}

            {roster.sideProblem && showsServices ? (
              <p className="cal-muted">
                Couldn&apos;t load services, so what each person performs isn&apos;t shown:{' '}
                {roster.sideProblem}
              </p>
            ) : null}

            <div className="roster" role="list" aria-label="Staff">
              <div className="roster-head roster-grid-stf" aria-hidden="true">
                <span>Name</span>
                <span>Email</span>
                <span>Phone</span>
                {showsServices ? <span>Performs</span> : <span />}
                <span>Status</span>
              </div>
              {visible.map((m) => {
                const detailId = `stf-detail-${m.id}`;
                const isOpen = open === m.id;
                const reported =
                  m.serviceIds !== undefined || roster.services.some((s) => s.staffIds);
                const doing = roster.services.filter((s) => performs(s, m) === true);
                return (
                  <div
                    key={m.id}
                    className={`roster-item ${isOpen ? 'is-open' : ''} ${m.active ? '' : 'is-inactive'}`}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="roster-row roster-grid-stf"
                      aria-expanded={isOpen}
                      aria-controls={detailId}
                      onClick={() => setOpen(isOpen ? null : m.id)}
                    >
                      <span className="roster-name">{m.name}</span>
                      <span className="roster-cell roster-clip" data-label="Email">
                        {m.email || '—'}
                      </span>
                      <span className="roster-cell" data-label="Phone">
                        {m.phone || '—'}
                      </span>
                      <span className="roster-cell" data-label="Performs">
                        {!showsServices ? null : !reported ? (
                          <span className="roster-aside">Not reported</span>
                        ) : (
                          <span title={doing.map((s) => s.name).join(', ') || undefined}>
                            {doing.length === 0
                              ? 'Nothing yet'
                              : `${doing.length} of ${roster.services.length} services`}
                          </span>
                        )}
                      </span>
                      <span className="roster-cell">
                        <span
                          className={`rb-status ${m.active ? 'rb-status-pine' : 'rb-status-inkfaint'}`}
                        >
                          {m.active ? 'Active' : 'Inactive'}
                        </span>
                      </span>
                    </button>
                    {isOpen ? (
                      <div id={detailId} className="roster-detail">
                        {canWrite ? (
                          <StaffForm
                            key={`${m.id}:${m.name}:${m.email}:${m.phone}:${m.active}`}
                            mode="edit"
                            idBase={`stf-${m.id}`}
                            member={m}
                            canDeactivate={caps.staffDeactivate}
                            emailRequired={false}
                            busy={isBusy}
                            onSubmit={(input) => {
                              if (Object.keys(input).length === 0) {
                                setResult({ ok: true, data: { unchanged: true, id: m.id } });
                                return Promise.resolve();
                              }
                              if (
                                input.status === 'inactive' &&
                                !window.confirm(
                                  `Deactivate ${m.name}? They stop being bookable.`,
                                )
                              ) {
                                return Promise.resolve();
                              }
                              return roster.act(() => callUpdateStaff(P, conn, m.id, input), (d) =>
                                onSaved(d as Staff),
                              );
                            }}
                          />
                        ) : null}
                        {showsServices ? (
                          <AssignChecklist
                            legend="Performs"
                            call="client.assignStaffToService(serviceId, staffId) / unassignStaffFromService(serviceId, staffId)"
                            editable={canAssign}
                            busy={isBusy}
                            emptyText={
                              roster.sideProblem
                                ? 'Services could not be loaded.'
                                : 'This account has no services.'
                            }
                            items={roster.services.map((s) => ({
                              id: s.id,
                              name: s.name,
                              inactive: !s.active,
                              checked: performs(s, m),
                            }))}
                            onToggle={(id, next) => toggleService(m, id, next)}
                          />
                        ) : null}
                        {caps.staffDelete ? <ApiHint call="client.deleteStaff(id)" /> : null}
                        <div className="roster-actions">
                          <IdLine id={m.id} />
                          <div className="roster-actions-end">
                            {caps.staffDelete ? (
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                onClick={() => remove(m)}
                                disabled={isBusy}
                              >
                                Delete staff member
                              </button>
                            ) : caps.staffDeactivate ? (
                              <span className="cal-muted">
                                {label} can&apos;t delete staff; set Status to Inactive instead.
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {visible.length === 0 ? (
              <div className="roster-empty">
                {search.trim() ? (
                  <>
                    <p>No loaded staff member matches “{search.trim()}”.</p>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => lookUp(search.trim())}
                      disabled={isBusy}
                    >
                      Look up “{search.trim()}” by ID
                    </button>
                  </>
                ) : status !== 'all' ? (
                  <p>No {status} staff members.</p>
                ) : (
                  <p>
                    {label} has no staff yet.
                    {canWrite ? ' Use Add staff member to create the first one.' : ''}
                  </p>
                )}
              </div>
            ) : null}

            {roster.moreStaff ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm roster-more"
                onClick={() => void roster.loadMore('staff')}
                disabled={isBusy}
              >
                Load more staff
              </button>
            ) : null}
          </>
        )}

        <ResultBox result={result} label="Last call" elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}

/** Create and edit share one form. Editing sends only what changed. */
function StaffForm({
  mode,
  idBase,
  member,
  canDeactivate,
  emailRequired,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  idBase: string;
  member?: Staff;
  /** The provider has an inactive state for staff (`staffDeactivate`). */
  canDeactivate?: boolean;
  emailRequired: boolean;
  busy: boolean;
  onSubmit: (input: Record<string, string>) => Promise<void>;
  onCancel?: () => void;
}) {
  const current = {
    status: member ? (member.active ? 'active' : 'inactive') : undefined,
    name: member?.name,
    email: member?.email,
    phone: member?.phone,
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = fieldsOf(e.currentTarget);
    void onSubmit(mode === 'edit' ? changed(f, current) : f);
  };
  return (
    <form
      className="roster-form"
      onSubmit={submit}
      aria-label={mode === 'create' ? 'New staff member' : `Edit ${member?.name}`}
    >
      <div className="roster-form-grid roster-form-grid-3">
        <Field
          id={`${idBase}-name`}
          name="name"
          label="Name"
          defaultValue={current.name}
          placeholder="Ana Silva"
          required
        />
        <Field
          id={`${idBase}-email`}
          name="email"
          label="Email"
          type="email"
          defaultValue={current.email}
          placeholder="ana@example.com"
          required={emailRequired}
          hint={emailRequired ? 'Required by this provider.' : undefined}
        />
        <Field
          id={`${idBase}-phone`}
          name="phone"
          label="Phone"
          type="tel"
          defaultValue={current.phone}
          placeholder="Optional"
        />
      </div>
      {mode === 'edit' && member && canDeactivate ? (
        <div className="roster-form-grid roster-form-grid-3">
          <StatusField id={`${idBase}-status`} active={member.active} />
        </div>
      ) : null}
      <div className="roster-form-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Add staff member' : 'Save changes'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <ApiHint call={mode === 'create' ? 'client.createStaff({ name, email, phone })' : 'client.updateStaff(id, { name, email, active })'} />
    </form>
  );
}
