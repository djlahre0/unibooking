'use client';

import { type ActionResult, type Connection, callFindOrCreateCustomer } from '../../lib/call';
import type { ProviderMeta } from '../../lib/providers';
import ResultBox from '../ResultBox';
import PersistedForm from '../PersistedForm';

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

export default function CustomersTab({
  selectedProvider,
  providerInfo,
  conn,
  customerResult,
  setCustomerResult,
  wrap,
  busy,
  elapsedMs,
}: CustomersTabProps) {
  return (
    <div className="fade-in">
      {!selectedProvider ? (
        <div className="empty-state">
          <span className="icon">👤</span>
          Select a provider in the Connect tab first
        </div>
      ) : (
        <div className="card">
          <div className="card-title">
            <span className="icon">👤</span> Customer Management — {providerInfo?.label}
          </div>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              marginBottom: '1rem',
            }}
          >
            <code>client.customers?.findOrCreate(customer)</code> — only when{' '}
            <code>capabilities.customers</code> is <code>true</code>
          </p>
          <PersistedForm
            formKey="customers:findOrCreate"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              wrap(
                'customer',
                () =>
                  callFindOrCreateCustomer(selectedProvider, conn, {
                    name: (fd.get('name') as string) || undefined,
                    email: (fd.get('email') as string) || undefined,
                    phone: (fd.get('phone') as string) || undefined,
                  }),
                setCustomerResult,
              );
            }}
          >
            <div className="two-col">
              <div className="form-group">
                <label className="form-label" htmlFor="cu-name">Name</label>
                <input
                  id="cu-name"
                  name="name"
                  className="form-input"
                  placeholder="Jane Doe"
                  defaultValue="Jane Doe"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cu-email">Email</label>
                <input
                  id="cu-email"
                  name="email"
                  className="form-input"
                  placeholder="jane@example.com"
                  defaultValue="jane@example.com"
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cu-phone">Phone</label>
                <input id="cu-phone" name="phone" className="form-input" placeholder="+1555..." />
              </div>
            </div>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy('customer')}
              style={{ marginTop: '1rem' }}
            >
              {busy('customer') ? '...' : '👤 Find or Create'}
            </button>
          </PersistedForm>
          <ResultBox result={customerResult} label="Customer" elapsedMs={elapsedMs} />
        </div>
      )}
    </div>
  );
}
