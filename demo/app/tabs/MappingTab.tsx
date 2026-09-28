'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { Service, Staff } from 'unibooking';
import {
  type ActionResult,
  type Connection,
  callListServices,
  callListStaff,
  callOp,
  providerCapabilities,
} from '../../lib/call';
import { isLocal, type ProviderMeta } from '../../lib/providers';
import {
  addRecord,
  clearRecords,
  editRecord,
  importRecord,
  linkRecord,
  loadRecords,
  saveRecords,
  statusOf,
  syncRecords,
  unlinkRecord,
  type Kind,
  type LinkStatus,
  type RecordSyncReport,
  type UbRecord,
} from '../../lib/record-sync';
import ResultBox from '../ResultBox';
import { seedDemoProject } from '../../lib/project';
import { browserZone } from '../../lib/datetime';
import ApiHint from '../ApiHint';
import { minutes, money } from './catalog/useRoster';

export type MappingTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  result: ActionResult | null;
  setResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  elapsedMs?: number;
};

const SECTION = 'mapping';
type Remote = Staff | Service;

const STATUS_TEXT: Record<LinkStatus, string> = {
  linked: 'Linked',
  changed: 'Changed in project',
  removed: 'Gone from provider',
  'local-only': 'Not linked',
};
const STATUS_TONE: Record<LinkStatus, string> = {
  linked: 'pine',
  changed: 'amber',
  removed: 'rose',
  'local-only': 'inkfaint',
};

/** One line of detail under a name: email for a person, length and price for
 *  a service. */
function detail(kind: Kind, r: Partial<UbRecord> | Remote): string {
  if (kind === 'staff') return (r as { email?: string }).email ?? '';
  const s = r as { durationMinutes?: number; price?: UbRecord['price'] };
  return [minutes(s.durationMinutes), money(s.price)].filter(Boolean).join(', ');
}

export default function MappingTab({
  selectedProvider: P,
  providerInfo,
  conn,
  result,
  setResult,
  wrap,
  busy,
  elapsedMs,
}: MappingTabProps) {
  const caps = P ? providerCapabilities(P) : null;
  const label = providerInfo?.label ?? P;
  const isBusy = busy(SECTION);
  const [kind, setKind] = useState<Kind>(caps?.staffDirectory ? 'staff' : 'services');
  const [store, setStore] = useState(() => loadRecords());
  const [remote, setRemote] = useState<Remote[] | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [report, setReport] = useState<RecordSyncReport | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const update = (next: typeof store) => {
    setStore(next);
    saveRecords(next);
  };


  const canList = kind === 'staff' ? !!caps?.staffDirectory : !!caps?.serviceCatalog;
  const canWrite = kind === 'staff' ? !!caps?.staffDirectoryWrite : !!caps?.serviceCatalogWrite;
  const what = kind === 'staff' ? 'staff' : 'services';
  const mine = useMemo(() => store.records.filter((r) => r.kind === kind), [store, kind]);
  const byRemoteId = useMemo(() => {
    const m = new Map<string, UbRecord>();
    for (const r of mine) {
      const l = r.links[P];
      if (l && !l.removed) m.set(l.providerId, r);
    }
    return m;
  }, [mine, P]);
  const unlinkedMine = mine.filter((r) => !r.links[P] || r.links[P]!.removed);
  const unlinkedRemote = (remote ?? []).filter((x) => !byRemoteId.has(x.id));
  const remoteName = (id: string) => remote?.find((x) => x.id === id)?.name ?? id;

  if (!P) {
    return (
      <div className="fade-in">
        <div className="empty-state">Choose a provider in the sidebar to start.</div>
      </div>
    );
  }
  if (!caps?.staffDirectory && !caps?.serviceCatalog) {
    return (
      <div className="fade-in">
        <div className="card">
          <div className="card-title">Mapping</div>
          <p className="cal-muted">
            {label} has no staff or services to map. Mapping links your project&apos;s staff and
            services to a booking platform&apos;s, such as Square or the Sample Salon.
          </p>
        </div>
      </div>
    );
  }

  const loadRemote = () =>
    wrap(
      SECTION,
      async () => {
        const r =
          kind === 'staff'
            ? await callListStaff(P, conn, { limit: 100 })
            : await callListServices(P, conn, { limit: 100 });
        if (r.ok) {
          const d = r.data as { staff?: Staff[]; services?: Service[] };
          setRemote((kind === 'staff' ? d.staff : d.services) ?? []);
        }
        return r;
      },
      setResult,
    );

  /** Run the engine with the given switches, then re-read the provider list
   *  so the right-hand side shows what the provider now holds. */
  const run = (o: { autoMatch: boolean; importUnmatched: boolean; createMissingAtProvider: boolean }) =>
    wrap(
      SECTION,
      async () => {
        try {
          const { data, report: rep } = await syncRecords(store, {
            provider: P,
            conn,
            kind,
            call: callOp,
            canWrite,
            ...o,
          });
          update(data);
          setReport(rep);
          const r =
            kind === 'staff'
              ? await callListStaff(P, conn, { limit: 100 })
              : await callListServices(P, conn, { limit: 100 });
          if (r.ok) {
            const d = r.data as { staff?: Staff[]; services?: Service[] };
            setRemote((kind === 'staff' ? d.staff : d.services) ?? []);
          }
          return { ok: true, data: rep };
        } catch (e) {
          return { ok: false, error: { message: (e as Error).message } };
        }
      },
      setResult,
    );

  const createAtProvider = (r: UbRecord) =>
    wrap(
      SECTION,
      async () => {
        const res = await callOp(P, conn, kind === 'staff' ? 'createStaff' : 'createService', {
          name: r.name,
          ...(r.email ? { email: r.email } : {}),
          ...(r.phone ? { phone: r.phone } : {}),
          ...(r.durationMinutes !== undefined ? { durationMinutes: String(r.durationMinutes) } : {}),
          ...(r.price
            ? { price: (r.price.amount / 100).toFixed(2), currency: r.price.currency }
            : {}),
        });
        if (res.ok) {
          const created = res.data as Remote;
          update(linkRecord(store, r.id, P, created));
          setRemote((l) => [...(l ?? []), created]);
        }
        return res;
      },
      setResult,
    );

  const counts = {
    linked: mine.filter((r) => statusOf(r, P) === 'linked').length,
    changed: mine.filter((r) => statusOf(r, P) === 'changed').length,
  };

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title roster-title">
          <span>Mapping</span>
          <span className="roster-count">
            your project ↔ {label}
          </span>
        </div>
        <p className="cal-muted map-intro">
          Your project keeps its own {what}. Link each one to its record in {label}, which owns
          the data. Linking never copies or merges anything: import and create are separate,
          explicit steps.
        </p>

        <div className="op-row" role="tablist" aria-label="What to map">
          {(['staff', 'services'] as const).map((k) => {
            const ok = k === 'staff' ? caps?.staffDirectory : caps?.serviceCatalog;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                className={`btn btn-sm ${kind === k ? 'btn-primary' : 'btn-secondary'}`}
                disabled={!ok}
                title={ok ? undefined : `${label} has no ${k}`}
                onClick={() => {
                  // A different kind is a different right-hand list. (A
                  // different provider remounts the tab: page.tsx keys it.)
                  if (k === kind) return;
                  setKind(k);
                  setRemote(null);
                  setReport(null);
                  setFocus(null);
                  setEditing(null);
                  setAdding(false);
                }}
              >
                {k === 'staff' ? 'Staff' : 'Services'}
              </button>
            );
          })}
        </div>

        {!isLocal(P) && canWrite ? (
          <p className="conn-verdict conn-verdict-warn roster-warning" role="note">
            &ldquo;Create at {label}&rdquo; and pushing project changes write to the real {label}{' '}
            account. Use a sandbox or test account.
          </p>
        ) : null}

        <div className="map-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadRemote()}
            disabled={isBusy || !canList}
          >
            {remote ? `Reload ${label} ${what}` : `Load ${label} ${what}`}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void run({ autoMatch: true, importUnmatched: false, createMissingAtProvider: false })}
            disabled={isBusy || !canList}
            title={kind === 'staff' ? 'Links records with the same email' : 'Links records with the same name'}
          >
            Auto-match ({kind === 'staff' ? 'email' : 'name'})
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void run({ autoMatch: false, importUnmatched: false, createMissingAtProvider: false })}
            disabled={isBusy || !canList || counts.linked + counts.changed === 0}
          >
            Sync linked
          </button>
        </div>
        <ApiHint call={`client.${kind === 'staff' ? 'listStaff' : 'listServices'}({ pageToken }) · client.${kind === 'staff' ? 'updateStaff' : 'updateService'}(id, fields)`}>
          Sync pulls {label}&apos;s changes into linked records and pushes project changes back
          {canWrite ? '' : ` (${label} is read-only here, so project changes stay in the project)`};
          if both changed, {label} wins.
        </ApiHint>

        <div className="map-sides">
          {/* ── Left: the project's own records ── */}
          <section className="map-side" aria-label="Your project">
            <div className="map-side-head">
              <h3>Your project</h3>
              <span className="roster-count">
                {mine.length} {what}, {counts.linked + counts.changed} linked
              </span>
            </div>
            {mine.length === 0 ? (
              <div className="map-empty">
                <p className="cal-muted">
                  No {what} in your project yet. Add one, import from {label} on the right, or
                  load a demo salon.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    seedDemoProject(browserZone());
                    setStore(loadRecords());
                  }}
                >
                  Load demo salon
                </button>
              </div>
            ) : null}
            <ul className="map-list">
              {mine.map((r) => {
                const st = statusOf(r, P);
                const link = r.links[P];
                const isFocus = focus === r.id || (!!link && focus === link.providerId);
                return (
                  <li
                    key={r.id}
                    className={`map-row ${isFocus ? 'is-focus' : ''}`}
                    onMouseEnter={() => setFocus(r.id)}
                    onMouseLeave={() => setFocus(null)}
                  >
                    <div className="map-row-main">
                      <span className="map-name">{r.name}</span>
                      <span className="map-detail">{detail(kind, r)}</span>
                    </div>
                    <span className={`rb-status rb-status-${STATUS_TONE[st]}`}>{STATUS_TEXT[st]}</span>
                    {link && !link.removed ? (
                      <span className="map-partner">→ {remoteName(link.providerId)}</span>
                    ) : null}
                    <div className="map-row-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setEditing(editing === r.id ? null : r.id)}
                        disabled={isBusy}
                      >
                        {editing === r.id ? 'Close' : 'Edit'}
                      </button>
                      {link ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => update(unlinkRecord(store, r.id, P))}
                          disabled={isBusy}
                        >
                          Unlink
                        </button>
                      ) : canWrite ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void createAtProvider(r)}
                          disabled={isBusy}
                        >
                          Create at {label}
                        </button>
                      ) : null}
                    </div>
                    {editing === r.id ? (
                      <RecordForm
                        kind={kind}
                        record={r}
                        onSave={(f) => {
                          update(editRecord(store, r.id, f));
                          setEditing(null);
                        }}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {adding ? (
              <RecordForm
                kind={kind}
                onSave={(f) => {
                  update(addRecord(store, kind, f as { name: string }));
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAdding(true)}
              >
                Add a project {kind === 'staff' ? 'staff member' : 'service'}
              </button>
            )}
            {canWrite && unlinkedMine.length > 0 ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm map-bulk"
                  onClick={() =>
                    void run({ autoMatch: false, importUnmatched: false, createMissingAtProvider: true })
                  }
                  disabled={isBusy}
                >
                  Create all {unlinkedMine.length} unlinked at {label}
                </button>
                <ApiHint call={`client.${kind === 'staff' ? 'createStaff' : 'createService'}(fields)`} />
              </>
            ) : null}
          </section>

          {/* ── Right: the connected provider's records ── */}
          <section className="map-side" aria-label={label}>
            <div className="map-side-head">
              <h3>{label}</h3>
              {remote ? (
                <span className="roster-count">
                  {remote.length} {what}, {unlinkedRemote.length} not linked
                </span>
              ) : null}
            </div>
            {!canList ? (
              <p className="cal-muted map-empty">{label} has no {what}.</p>
            ) : remote === null ? (
              <p className="cal-muted map-empty">
                Load {label}&apos;s {what} to link them.
              </p>
            ) : remote.length === 0 ? (
              <p className="cal-muted map-empty">{label} has no {what} yet.</p>
            ) : null}
            <ul className="map-list">
              {(remote ?? []).map((x) => {
                const partner = byRemoteId.get(x.id);
                const isFocus = focus === x.id || (!!partner && focus === partner.id);
                return (
                  <li
                    key={x.id}
                    className={`map-row ${isFocus ? 'is-focus' : ''}`}
                    onMouseEnter={() => setFocus(x.id)}
                    onMouseLeave={() => setFocus(null)}
                  >
                    <div className="map-row-main">
                      <span className="map-name">
                        {x.name}
                        {x.active ? null : <span className="roster-aside"> (inactive)</span>}
                      </span>
                      <span className="map-detail">{detail(kind, x)}</span>
                    </div>
                    <span className={`rb-status rb-status-${partner ? 'pine' : 'inkfaint'}`}>
                      {partner ? 'Linked' : 'Not linked'}
                    </span>
                    {partner ? (
                      <span className="map-partner">← {partner.name}</span>
                    ) : (
                      <div className="map-row-actions">
                        <label className="sr-only" htmlFor={`map-link-${x.id}`}>
                          Link {x.name} to a project record
                        </label>
                        <select
                          id={`map-link-${x.id}`}
                          className="form-select map-link-select"
                          value=""
                          disabled={isBusy || unlinkedMine.length === 0}
                          onChange={(e) => {
                            if (e.target.value) update(linkRecord(store, e.target.value, P, x));
                          }}
                        >
                          <option value="">
                            {unlinkedMine.length ? 'Link to project record…' : 'No unlinked project records'}
                          </option>
                          {unlinkedMine.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                              {kind === 'staff' && r.email ? ` (${r.email})` : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => update(importRecord(store, kind, P, x))}
                          disabled={isBusy}
                        >
                          Import to project
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {unlinkedRemote.length > 0 ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm map-bulk"
                onClick={() =>
                  void run({ autoMatch: false, importUnmatched: true, createMissingAtProvider: false })
                }
                disabled={isBusy}
              >
                Import all {unlinkedRemote.length} unlinked into project
              </button>
            ) : null}
            <ApiHint call={`client.${kind === 'staff' ? 'listStaff' : 'listServices'}() → Staff.id / Service.id`}>
              The provider&apos;s id is what a link stores.
            </ApiHint>
          </section>
        </div>

        {report ? <MapReport report={report} provider={label} /> : null}

        <div className="map-footer">
          <button
            type="button"
            className="btn btn-secondary btn-sm cal-danger"
            onClick={() => {
              if (window.confirm('Clear every project record and link kept in this browser?')) {
                clearRecords();
                setStore(loadRecords());
                setReport(null);
              }
            }}
            disabled={isBusy || store.records.length === 0}
          >
            Clear project records
          </button>
          <span className="cal-muted">
            In this demo your project is stored in this browser; in your app it is your database.
          </span>
        </div>

        <ResultBox result={result} label="Last call" elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}

function MapReport({ report, provider }: { report: RecordSyncReport; provider: string }) {
  const parts = [
    report.linked && `${report.linked} matched and linked`,
    report.imported && `${report.imported} imported`,
    report.pulled && `${report.pulled} updated from ${provider}`,
    report.pushed && `${report.pushed} sent to ${provider}`,
    report.created && `${report.created} created at ${provider}`,
    report.unchanged && `${report.unchanged} already in step`,
    report.conflicts && `${report.conflicts} conflicts (${provider} won)`,
    report.removed && `${report.removed} gone from ${provider}`,
    report.heldLocally && `${report.heldLocally} project changes kept locally`,
    report.unlinked && `${report.unlinked} left unlinked`,
  ].filter(Boolean);
  const ok = report.errors.length === 0;
  return (
    <div className={`conn-verdict conn-verdict-${ok ? 'ok' : 'bad'}`} role="status">
      <div className="conn-verdict-title">{ok ? 'Done' : 'Done, with problems'}</div>
      <p className="conn-verdict-detail">{parts.length ? parts.join(' · ') : 'Nothing to do.'}</p>
      {report.errors.length ? (
        <ul className="conn-verdict-hints">
          {report.errors.map((e, i) => (
            <li key={i}>
              {e.name}: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Add or edit a project record: the few fields that are mapped. */
function RecordForm({
  kind,
  record,
  onSave,
  onCancel,
}: {
  kind: Kind;
  record?: UbRecord;
  onSave: (fields: Partial<UbRecord>) => void;
  onCancel?: () => void;
}) {
  const base = record ? `map-edit-${record.id}` : 'map-new';
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? '').trim();
    const name = get('name');
    if (!name) return;
    if (kind === 'staff') {
      onSave({
        name,
        email: get('email') || undefined,
        phone: get('phone') || undefined,
      });
    } else {
      const mins = Number(get('durationMinutes'));
      const price = Number(get('price'));
      const currency = get('currency').toUpperCase();
      onSave({
        name,
        ...(mins > 0 ? { durationMinutes: mins } : {}),
        ...(get('price') && Number.isFinite(price) && currency
          ? { price: { amount: Math.round(price * 100), currency } }
          : {}),
      });
    }
  };
  return (
    <form
      className="map-form"
      onSubmit={submit}
      aria-label={record ? `Edit project record ${record.name}` : 'New project record'}
    >
      <div className="form-group">
        <label className="form-label" htmlFor={`${base}-name`}>
          Name
        </label>
        <input id={`${base}-name`} name="name" className="form-input" defaultValue={record?.name} required />
      </div>
      {kind === 'staff' ? (
        <div className="form-group">
          <label className="form-label" htmlFor={`${base}-email`}>
            Email
          </label>
          <input
            id={`${base}-email`}
            name="email"
            type="email"
            className="form-input"
            defaultValue={record?.email}
          />
        </div>
      ) : (
        <>
          <div className="form-group">
            <label className="form-label" htmlFor={`${base}-dur`}>
              Length (minutes)
            </label>
            <input
              id={`${base}-dur`}
              name="durationMinutes"
              type="number"
              min="1"
              step="1"
              className="form-input"
              defaultValue={record?.durationMinutes}
            />
          </div>
          <div className="map-form-pair">
            <div className="form-group">
              <label className="form-label" htmlFor={`${base}-price`}>
                Price
              </label>
              <input
                id={`${base}-price`}
                name="price"
                type="number"
                min="0"
                step="0.01"
                className="form-input"
                defaultValue={record?.price ? (record.price.amount / 100).toFixed(2) : undefined}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`${base}-cur`}>
                Currency
              </label>
              <input
                id={`${base}-cur`}
                name="currency"
                className="form-input"
                defaultValue={record?.price?.currency}
                placeholder="USD"
              />
            </div>
          </div>
        </>
      )}
      <div className="roster-form-actions">
        <button type="submit" className="btn btn-primary btn-sm">
          {record ? 'Save in project' : 'Add to project'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
