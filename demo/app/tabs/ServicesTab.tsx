'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { Service, Staff } from 'unibooking';
import {
  type ActionResult,
  type Connection,
  callAssignStaff,
  callCreateService,
  callDeleteService,
  callGetService,
  callUnassignStaff,
  callUpdateService,
  providerCapabilities,
} from '../../lib/call';
import { isLocal, type ProviderMeta } from '../../lib/providers';
import ResultBox from '../ResultBox';
import ApiHint from '../ApiHint';
import { initials, minutes, money, performs, useRoster, type Wrap } from './catalog/useRoster';
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

export type ServicesTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  result: ActionResult | null;
  setResult: (r: ActionResult | null) => void;
  wrap: Wrap;
  busy: (section: string) => boolean;
  elapsedMs?: number;
};

const SECTION = 'services';

export default function ServicesTab(props: ServicesTabProps) {
  const { selectedProvider: P, providerInfo, conn, result, setResult, wrap, busy, elapsedMs } =
    props;
  const caps = P ? providerCapabilities(P) : null;
  const label = providerInfo?.label ?? P;
  const roster = useRoster({
    provider: P,
    conn,
    caps,
    primary: 'services',
    section: SECTION,
    wrap,
    setResult,
  });
  const [search, setSearch] = useState('');
  const [performer, setPerformer] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const isBusy = busy(SECTION);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const who = roster.staff.find((m) => m.id === performer);
    return roster.services.filter(
      (s) =>
        (!q || s.name.toLowerCase().includes(q) || s.id.toLowerCase() === q) &&
        (!who || performs(s, who) === true),
    );
  }, [roster.services, roster.staff, search, performer]);

  if (!P) {
    return (
      <div className="fade-in">
        <div className="empty-state">Choose a provider in the sidebar to start.</div>
      </div>
    );
  }

  if (!caps?.serviceCatalog) {
    return (
      <div className="fade-in">
        <div className="card">
          <div className="card-title">Services</div>
          <p className="cal-muted">
            {label} has no service catalog to show. Services come from booking platforms such as
            Square, Acuity or Microsoft Bookings; try the Sample Salon to see this tab working.
          </p>
        </div>
      </div>
    );
  }

  const canWrite = caps.serviceCatalogWrite;
  const canAssign = caps.staffServiceAssignmentWrite;
  const showsPerformers = caps.staffServiceAssignment;
  const limits = [
    !canWrite && 'add or edit services',
    canWrite && !caps.serviceDelete && 'delete services (deactivate one instead)',
    showsPerformers && !canAssign && 'change who performs a service',
  ].filter((x): x is string => !!x);
  const defaultCurrency = roster.services.find((s) => s.price)?.price?.currency ?? '';

  const onSaved = (s: Service) => {
    roster.upsertService(s);
    setOpen(s.id);
  };

  const remove = (s: Service) => {
    if (!window.confirm(`Delete “${s.name}” for good? This can't be undone.`)) return;
    void roster.act(
      () => callDeleteService(P, conn, s.id),
      () => {
        roster.dropService(s.id);
        setOpen(null);
      },
    );
  };

  const toggleStaff = (s: Service, staffId: string, next: boolean) => {
    void roster.act(
      () =>
        next ? callAssignStaff(P, conn, s.id, staffId) : callUnassignStaff(P, conn, s.id, staffId),
      (d) => roster.upsertService(d as Service),
    );
  };

  const lookUp = (id: string) => {
    void roster.act(
      () => callGetService(P, conn, id),
      (d) => {
        const s = d as Service;
        roster.upsertService(s);
        setSearch('');
        setOpen(s.id);
        reveal(`svc-detail-${s.id}`);
      },
    );
  };

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title roster-title">
          <span>Services</span>
          {roster.loaded ? (
            <span className="roster-count">
              {roster.services.length}
              {roster.moreServices ? '+' : ''} in {label}
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

        <OpenById what="Service" busy={isBusy} onOpen={lookUp} call="client.getService(id)" />

        {!roster.loaded && roster.services.length === 0 ? (
          <LoadPrompt
            what="services"
            provider={label}
            busy={isBusy}
            onLoad={() => void roster.load()}
            call="client.listServices({ limit: 100 })"
          />
        ) : (
          <>
            <RosterToolbar
              search={search}
              onSearch={setSearch}
              searchLabel="Search services by name or ID"
              filter={
                showsPerformers && roster.staff.length > 0 ? (
                  <select
                    className="form-select roster-filter"
                    aria-label="Performed by"
                    value={performer}
                    onChange={(e) => setPerformer(e.target.value)}
                  >
                    <option value="">Performed by anyone</option>
                    {roster.staff.map((m) => (
                      <option key={m.id} value={m.id}>
                        Performed by {m.name}
                      </option>
                    ))}
                  </select>
                ) : null
              }
              action={
                canWrite ? (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    aria-expanded={adding}
                    onClick={() => setAdding((a) => !a)}
                  >
                    {adding ? 'Close' : 'Add service'}
                  </button>
                ) : null
              }
            />

            {adding ? (
              <div className="roster-new">
                <ServiceForm
                  mode="create"
                  idBase="svc-new"
                  defaultCurrency={defaultCurrency}
                  busy={isBusy}
                  onCancel={() => setAdding(false)}
                  onSubmit={(input) =>
                    roster.act(
                      () => callCreateService(P, conn, input),
                      (d) => {
                        setAdding(false);
                        onSaved(d as Service);
                      },
                    )
                  }
                />
              </div>
            ) : null}

            {roster.sideProblem && showsPerformers ? (
              <p className="cal-muted">Couldn&apos;t load staff, so performers aren&apos;t shown: {roster.sideProblem}</p>
            ) : null}

            <div className="roster" role="list" aria-label="Services">
              <div className="roster-head roster-grid-svc" aria-hidden="true">
                <span>Service</span>
                <span>Length</span>
                <span className="roster-num">Price</span>
                {showsPerformers ? <span>Performed by</span> : <span />}
                <span>Status</span>
              </div>
              {visible.map((s) => (
                <ServiceRow
                  key={s.id}
                  service={s}
                  staff={roster.staff}
                  showsPerformers={showsPerformers}
                  open={open === s.id}
                  onToggle={() => setOpen(open === s.id ? null : s.id)}
                >
                  <ServiceForm
                    key={`${s.id}:${s.name}:${s.durationMinutes}:${s.price?.amount}:${s.active}`}
                    mode="edit"
                    idBase={`svc-${s.id}`}
                    service={s}
                    defaultCurrency={defaultCurrency}
                    busy={isBusy}
                    readOnly={!canWrite}
                    onSubmit={(input) => {
                      if (Object.keys(input).length === 0) {
                        setResult({ ok: true, data: { unchanged: true, id: s.id } });
                        return Promise.resolve();
                      }
                      if (
                        input.status === 'inactive' &&
                        !window.confirm(`Deactivate “${s.name}”? It stops being bookable.`)
                      ) {
                        return Promise.resolve();
                      }
                      return roster.act(() => callUpdateService(P, conn, s.id, input), (d) =>
                        onSaved(d as Service),
                      );
                    }}
                  />
                  {showsPerformers ? (
                    <AssignChecklist
                      legend="Performed by"
                      call="client.assignStaffToService(serviceId, staffId) / unassignStaffFromService(serviceId, staffId)"
                      editable={canAssign}
                      busy={isBusy}
                      emptyText={
                        roster.sideProblem ? 'Staff could not be loaded.' : 'This account has no staff.'
                      }
                      items={roster.staff.map((m) => ({
                        id: m.id,
                        name: m.name,
                        inactive: !m.active,
                        checked: performs(s, m),
                      }))}
                      onToggle={(id, next) => toggleStaff(s, id, next)}
                    />
                  ) : null}
                  {caps.serviceDelete ? <ApiHint call="client.deleteService(id)" /> : null}
                  <div className="roster-actions">
                    <IdLine id={s.id} />
                    <div className="roster-actions-end">
                      {caps.serviceDelete ? (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => remove(s)}
                          disabled={isBusy}
                        >
                          Delete service
                        </button>
                      ) : canWrite ? (
                        <span className="cal-muted">
                          {label} can&apos;t delete services; set Status to Inactive instead.
                        </span>
                      ) : null}
                    </div>
                  </div>
                </ServiceRow>
              ))}
            </div>

            {visible.length === 0 ? (
              <div className="roster-empty">
                {search.trim() ? (
                  <>
                    <p>No loaded service matches “{search.trim()}”.</p>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => lookUp(search.trim())}
                      disabled={isBusy}
                    >
                      Look up “{search.trim()}” by ID
                    </button>
                  </>
                ) : performer ? (
                  <p>
                    {roster.staff.find((m) => m.id === performer)?.name ?? 'That staff member'}{' '}
                    doesn&apos;t perform any of the loaded services.
                  </p>
                ) : (
                  <p>
                    {label} has no services yet.
                    {canWrite ? ' Use Add service to create the first one.' : ''}
                  </p>
                )}
              </div>
            ) : null}

            {roster.moreServices ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm roster-more"
                onClick={() => void roster.loadMore('services')}
                disabled={isBusy}
              >
                Load more services
              </button>
            ) : null}
          </>
        )}

        <ResultBox result={result} label="Last call" elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}

/** One collapsible ledger row. */
function ServiceRow({
  service: s,
  staff,
  showsPerformers,
  open,
  onToggle,
  children,
}: {
  service: Service;
  staff: Staff[];
  showsPerformers: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const detailId = `svc-detail-${s.id}`;
  const who = staff.filter((m) => performs(s, m) === true);
  return (
    <div className={`roster-item ${open ? 'is-open' : ''} ${s.active ? '' : 'is-inactive'}`} role="listitem">
      <button
        type="button"
        className="roster-row roster-grid-svc"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <span className="roster-name">
          {s.name}
          {s.categoryName ? <span className="roster-aside">{s.categoryName}</span> : null}
        </span>
        <span className="roster-cell" data-label="Length">
          {minutes(s.durationMinutes) || '-'}
        </span>
        <span className="roster-cell roster-num" data-label="Price">
          {money(s.price) || '-'}
        </span>
        <span className="roster-cell" data-label="Performed by">
          {showsPerformers ? <Performers staff={who} reported={s.staffIds !== undefined || staff.some((m) => m.serviceIds)} /> : null}
        </span>
        <span className="roster-cell">
          <span className={`rb-status ${s.active ? 'rb-status-pine' : 'rb-status-inkfaint'}`}>
            {s.active ? 'Active' : 'Inactive'}
          </span>
        </span>
      </button>
      {open ? (
        <div id={detailId} className="roster-detail">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Performers as ink initials: the at-a-glance "who does this". */
function Performers({ staff, reported }: { staff: Staff[]; reported: boolean }) {
  if (!reported) return <span className="roster-aside">Not reported</span>;
  if (staff.length === 0) return <span className="roster-aside">Nobody</span>;
  const shown = staff.slice(0, 4);
  return (
    <span className="roster-marks" aria-label={staff.map((m) => m.name).join(', ')}>
      {shown.map((m) => (
        <span key={m.id} className="roster-mark" title={m.name} aria-hidden="true">
          {initials(m.name)}
        </span>
      ))}
      {staff.length > shown.length ? (
        <span className="roster-mark roster-mark-more" aria-hidden="true">
          +{staff.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

type ServiceInput = Record<string, string>;

/** Create and edit share one form. Editing sends only what changed. */
function ServiceForm({
  mode,
  idBase,
  service,
  defaultCurrency,
  busy,
  readOnly,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  idBase: string;
  service?: Service;
  defaultCurrency: string;
  busy: boolean;
  readOnly?: boolean;
  onSubmit: (input: ServiceInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [problem, setProblem] = useState('');
  const current = {
    status: service ? (service.active ? 'active' : 'inactive') : undefined,
    name: service?.name,
    description: service?.description,
    durationMinutes: service?.durationMinutes?.toString(),
    price: service?.price ? (service.price.amount / 100).toFixed(2) : undefined,
    currency: service?.price?.currency,
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = fieldsOf(e.currentTarget);
    if (f.price && !f.currency) {
      setProblem('Add a currency code, such as USD or GBP, to go with the price.');
      return;
    }
    setProblem('');
    let input: ServiceInput = f;
    if (mode === 'edit') {
      input = changed(f, current);
      // Price and currency travel together: one without the other is not a price.
      if (input.price || input.currency) {
        if (f.price) input.price = f.price;
        if (f.currency) input.currency = f.currency;
      }
    }
    void onSubmit(input);
  };

  if (readOnly) {
    return (
      <dl className="roster-facts">
        {service?.description ? (
          <>
            <dt>Description</dt>
            <dd>{service.description}</dd>
          </>
        ) : null}
        {service?.categoryName ? (
          <>
            <dt>Category</dt>
            <dd>{service.categoryName}</dd>
          </>
        ) : null}
      </dl>
    );
  }

  return (
    <form className="roster-form" onSubmit={submit} aria-label={mode === 'create' ? 'New service' : `Edit ${service?.name}`}>
      <div className="roster-form-grid">
        <Field
          id={`${idBase}-name`}
          name="name"
          label="Name"
          defaultValue={current.name}
          placeholder="Gel manicure"
          required
        />
        <Field
          id={`${idBase}-dur`}
          name="durationMinutes"
          label="Length (minutes)"
          type="number"
          step="1"
          min="1"
          defaultValue={current.durationMinutes}
          placeholder="45"
        />
        <Field
          id={`${idBase}-price`}
          name="price"
          label="Price"
          type="number"
          step="0.01"
          min="0"
          defaultValue={current.price}
          placeholder="45.00"
        />
        <Field
          id={`${idBase}-cur`}
          name="currency"
          label="Currency"
          defaultValue={current.currency ?? defaultCurrency}
          placeholder="USD"
        />
      </div>
      {mode === 'edit' && service ? (
        <div className="roster-form-grid">
          <StatusField id={`${idBase}-status`} active={service.active} />
        </div>
      ) : null}
      <div className="form-group">
        <label className="form-label" htmlFor={`${idBase}-desc`}>
          Description
        </label>
        <textarea
          id={`${idBase}-desc`}
          name="description"
          className="form-textarea"
          rows={2}
          defaultValue={current.description}
          placeholder="Optional"
        />
      </div>
      {problem ? (
        <p className="roster-problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="roster-form-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Create service' : 'Save changes'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <ApiHint call={mode === 'create' ? 'client.createService({ name, durationMinutes, price })' : 'client.updateService(id, { name, price, active })'} />
    </form>
  );
}
