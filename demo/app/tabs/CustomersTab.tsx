'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { CustomerRecord } from 'unibooking';
import {
  type ActionResult,
  type Connection,
  callCreateCustomer,
  callDeleteCustomer,
  callFindOrCreateCustomer,
  callGetCustomer,
  callListCustomers,
  callUpdateCustomer,
  providerCapabilities,
} from '../../lib/call';
import { isLocal, type ProviderMeta } from '../../lib/providers';
import ResultBox from '../ResultBox';
import ApiHint from '../ApiHint';
import PersistedForm from '../PersistedForm';
import {
  changed,
  Field,
  fieldsOf,
  IdLine,
  Limits,
  LoadPrompt,
  OpenById,
  reveal,
  RosterToolbar,
} from './catalog/parts';

export type CustomersTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  customerResult: ActionResult | null;
  setCustomerResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  /** How long the last call took, measured in page.tsx's `wrap`. */
  elapsedMs?: number;
};

const SECTION = 'customer';
const PAGE = 100;

function upsert(list: CustomerRecord[], c: CustomerRecord): CustomerRecord[] {
  const at = list.findIndex((x) => x.id === c.id);
  if (at === -1) return [c, ...list];
  const next = list.slice();
  next[at] = c;
  return next;
}

/** "12 Mar 2026", or '' when the provider did not say. */
function added(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function CustomersTab({
  selectedProvider: P,
  providerInfo,
  conn,
  customerResult: result,
  setCustomerResult: setResult,
  wrap,
  busy,
  elapsedMs,
}: CustomersTabProps) {
  const caps = P ? providerCapabilities(P) : null;
  const label = providerInfo?.label ?? P;
  const isBusy = busy(SECTION);
  const [list, setList] = useState<CustomerRecord[]>([]);
  const [token, setToken] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const act = useCallback(
    (fn: () => Promise<ActionResult>, onOk?: (data: unknown) => void) =>
      wrap(SECTION, fn, (r) => {
        setResult(r);
        if (r.ok) onOk?.(r.data);
      }),
    [wrap, setResult],
  );

  const load = useCallback(
    (pageToken?: string) =>
      act(
        () => callListCustomers(P, conn, { limit: PAGE, ...(pageToken ? { pageToken } : {}) }),
        (d) => {
          const page = d as { customers: CustomerRecord[]; nextPageToken?: string };
          setList((prev) =>
            pageToken
              ? [...prev, ...page.customers.filter((c) => !prev.some((p) => p.id === c.id))]
              : page.customers,
          );
          setToken(page.nextPageToken);
          setLoaded(true);
        },
      ),
    [act, P, conn],
  );

  // The sample lives in this browser, so it can just be shown; a real account
  // is read only on request.
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || !isLocal(P) || !caps?.customerDirectory) return;
    auto.current = true;
    void load();
  }, [P, caps?.customerDirectory, load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) =>
      [c.name, c.email, c.phone, c.id].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [list, search]);

  if (!P) {
    return (
      <div className="fade-in">
        <div className="empty-state">Choose a provider in the sidebar to start.</div>
      </div>
    );
  }

  const openRecord = (c: CustomerRecord) => {
    setList((l) => upsert(l, c));
    setSearch('');
    setOpen(c.id);
    reveal(`cus-detail-${c.id}`);
  };
  const lookUp = (id: string) =>
    void act(() => callGetCustomer(P, conn, id), (d) => openRecord(d as CustomerRecord));
  // Search the whole account (not just what is loaded) by exact email.
  const findByEmail = (email: string) =>
    void act(
      () => callListCustomers(P, conn, { email, limit: 10 }),
      (d) => {
        const found = (d as { customers: CustomerRecord[] }).customers;
        if (found[0]) openRecord(found[0]);
      },
    );
  const remove = (c: CustomerRecord) => {
    if (!window.confirm(`Delete ${c.name ?? c.email ?? c.id} for good? This can't be undone.`))
      return;
    void act(
      () => callDeleteCustomer(P, conn, c.id),
      () => {
        setList((l) => l.filter((x) => x.id !== c.id));
        setOpen(null);
      },
    );
  };

  const canList = !!caps?.customerDirectory;
  const canWrite = !!caps?.customerWrite;
  const canDelete = !!caps?.customerDelete;
  const limits = !canList
    ? []
    : [
        !canWrite && 'add or edit clients',
        canWrite && !canDelete && 'delete clients',
      ].filter((x): x is string => !!x);
  const q = search.trim();

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title roster-title">
          <span>Clients</span>
          {loaded ? (
            <span className="roster-count">
              {list.length}
              {token ? '+' : ''} in {label}
            </span>
          ) : null}
          {loaded ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm roster-reload"
              onClick={() => void load()}
              disabled={isBusy}
            >
              Reload
            </button>
          ) : null}
        </div>

        {!canList ? (
          <p className="cal-muted">
            {caps?.customers
              ? `${label} can't list or look up its clients through its API. It can still match or create one for a booking, below.`
              : `${label} has no client records to show. Try the Sample Salon to see this tab working.`}
          </p>
        ) : (
          <>
            {!isLocal(P) && canWrite ? (
              <p className="conn-verdict conn-verdict-warn roster-warning" role="note">
                Changes here are made in the real {label} account these credentials belong to.
                Use a sandbox or test account.
              </p>
            ) : null}
            <Limits provider={label} items={limits} />
            <OpenById what="Client" busy={isBusy} onOpen={lookUp} call="client.customers.get(id)" />

            {!loaded && list.length === 0 ? (
              <LoadPrompt
                what="clients"
                provider={label}
                busy={isBusy}
                onLoad={() => void load()}
                call="client.customers.list({ limit: 100 })"
              />
            ) : (
              <>
                <RosterToolbar
                  search={search}
                  onSearch={setSearch}
                  searchLabel="Search clients by name, email or phone"
                  action={
                    canWrite ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        aria-expanded={adding}
                        onClick={() => setAdding((a) => !a)}
                      >
                        {adding ? 'Close' : 'Add client'}
                      </button>
                    ) : null
                  }
                />

                {adding ? (
                  <div className="roster-new">
                    <ClientForm
                      mode="create"
                      idBase="cus-new"
                      busy={isBusy}
                      onCancel={() => setAdding(false)}
                      onSubmit={(input) =>
                        act(
                          () => callCreateCustomer(P, conn, input),
                          (d) => {
                            setAdding(false);
                            openRecord(d as CustomerRecord);
                          },
                        )
                      }
                    />
                  </div>
                ) : null}

                <div className="roster" role="list" aria-label="Clients">
                  <div className="roster-head roster-grid-cus" aria-hidden="true">
                    <span>Name</span>
                    <span>Email</span>
                    <span>Phone</span>
                    <span>Added</span>
                  </div>
                  {visible.map((c) => {
                    const isOpen = open === c.id;
                    const detailId = `cus-detail-${c.id}`;
                    return (
                      <div key={c.id} className={`roster-item ${isOpen ? 'is-open' : ''}`} role="listitem">
                        <button
                          type="button"
                          className="roster-row roster-grid-cus"
                          aria-expanded={isOpen}
                          aria-controls={detailId}
                          onClick={() => setOpen(isOpen ? null : c.id)}
                        >
                          <span className="roster-name">{c.name || c.email || c.phone || c.id}</span>
                          <span className="roster-cell roster-clip" data-label="Email">
                            {c.email || '-'}
                          </span>
                          <span className="roster-cell" data-label="Phone">
                            {c.phone || '-'}
                          </span>
                          <span className="roster-cell" data-label="Added">
                            {added(c.createdAt) || '-'}
                          </span>
                        </button>
                        {isOpen ? (
                          <div id={detailId} className="roster-detail">
                            {canWrite ? (
                              <ClientForm
                                key={`${c.id}:${c.name}:${c.email}:${c.phone}:${c.note}`}
                                mode="edit"
                                idBase={`cus-${c.id}`}
                                client={c}
                                busy={isBusy}
                                onSubmit={(input) => {
                                  if (Object.keys(input).length === 0) {
                                    setResult({ ok: true, data: { unchanged: true, id: c.id } });
                                    return Promise.resolve();
                                  }
                                  return act(
                                    () => callUpdateCustomer(P, conn, c.id, input),
                                    (d) => openRecord(d as CustomerRecord),
                                  );
                                }}
                              />
                            ) : c.note ? (
                              <p className="cal-muted">{c.note}</p>
                            ) : null}
                            {canDelete ? <ApiHint call="client.customers.delete(id)" /> : null}
                            <div className="roster-actions">
                              <IdLine id={c.id} />
                              <div className="roster-actions-end">
                                {canDelete ? (
                                  <button
                                    type="button"
                                    className="btn btn-danger btn-sm"
                                    onClick={() => remove(c)}
                                    disabled={isBusy}
                                  >
                                    Delete client
                                  </button>
                                ) : canWrite ? (
                                  <span className="cal-muted">
                                    {label} can&apos;t delete clients through its API.
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
                    {q ? (
                      <>
                        <p>No loaded client matches “{q}”.</p>
                        {q.includes('@') ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => findByEmail(q)}
                              disabled={isBusy}
                            >
                              Search all of {label} for “{q}”
                            </button>
                            <ApiHint call="client.customers.list({ email })" />
                          </>
                        ) : (
                          <p>To search the whole account, type a full email address.</p>
                        )}
                      </>
                    ) : (
                      <p>
                        {label} has no clients yet.
                        {canWrite ? ' Use Add client to create the first one.' : ''}
                      </p>
                    )}
                  </div>
                ) : null}

                {token ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm roster-more"
                    onClick={() => void load(token)}
                    disabled={isBusy}
                  >
                    Load more clients
                  </button>
                ) : null}
              </>
            )}
          </>
        )}

        {caps?.customers ? (
          <details className="roster-findorcreate" open={!canList}>
            <summary>Match or create a client for a booking</summary>
            <p className="cal-muted">
              <code>customers.findOrCreate</code> reuses a client with the same email or phone,
              and creates one only when there is no match. This is what a booking flow calls.
            </p>
            <PersistedForm
              formKey="customers:findOrCreate"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                wrap(
                  SECTION,
                  () =>
                    callFindOrCreateCustomer(P, conn, {
                      name: (fd.get('name') as string) || undefined,
                      email: (fd.get('email') as string) || undefined,
                      phone: (fd.get('phone') as string) || undefined,
                    }),
                  setResult,
                );
              }}
            >
              <div className="roster-form-grid roster-form-grid-3">
                <Field id="cu-name" name="name" label="Name" placeholder="Jane Doe" />
                <Field id="cu-email" name="email" label="Email" placeholder="jane@example.com" />
                <Field id="cu-phone" name="phone" label="Phone" placeholder="+1555..." />
              </div>
              <button className="btn btn-secondary btn-sm" type="submit" disabled={isBusy}>
                {isBusy ? '...' : 'Match or create'}
              </button>
              <ApiHint call="client.customers.findOrCreate({ name, email, phone })">
                Returns the client id to put on a booking.
              </ApiHint>
            </PersistedForm>
          </details>
        ) : null}

        <ResultBox result={result} label="Last call" elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}

/** Create and edit share one form. Editing sends only what changed. */
function ClientForm({
  mode,
  idBase,
  client,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  idBase: string;
  client?: CustomerRecord;
  busy: boolean;
  onSubmit: (input: Record<string, string>) => Promise<void>;
  onCancel?: () => void;
}) {
  const [problem, setProblem] = useState('');
  const current = { name: client?.name, email: client?.email, phone: client?.phone, note: client?.note };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = fieldsOf(e.currentTarget);
    if (mode === 'create' && !f.name && !f.email && !f.phone) {
      setProblem('Give at least a name, email or phone.');
      return;
    }
    setProblem('');
    void onSubmit(mode === 'edit' ? changed(f, current) : f);
  };
  return (
    <form
      className="roster-form"
      onSubmit={submit}
      aria-label={mode === 'create' ? 'New client' : `Edit ${client?.name ?? client?.id}`}
    >
      <div className="roster-form-grid roster-form-grid-3">
        <Field id={`${idBase}-name`} name="name" label="Name" defaultValue={current.name} placeholder="Ana Silva" />
        <Field
          id={`${idBase}-email`}
          name="email"
          label="Email"
          type="email"
          defaultValue={current.email}
          placeholder="ana@example.com"
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
      <div className="form-group">
        <label className="form-label" htmlFor={`${idBase}-note`}>
          Note
        </label>
        <textarea
          id={`${idBase}-note`}
          name="note"
          className="form-textarea"
          rows={2}
          defaultValue={current.note}
          placeholder="Optional, where the provider keeps notes"
        />
      </div>
      {problem ? (
        <p className="roster-problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="roster-form-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Add client' : 'Save changes'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <ApiHint call={mode === 'create' ? 'client.customers.create({ name, email, phone, note })' : 'client.customers.update(id, { phone, note })'} />
    </form>
  );
}
