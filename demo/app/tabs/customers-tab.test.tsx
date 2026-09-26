/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomersTab from './CustomersTab';
import type { ActionResult } from '../../lib/call';
import { __resetUiState } from '../../lib/ui-state';
import { resetSample } from '../../lib/sample/store';

/** The tab plus the state page.tsx would hold, over the REAL sample provider. */
function Harness({ provider = 'sample', label = 'Sample Salon' }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busySection, setBusy] = useState('');
  return (
    <CustomersTab
      selectedProvider={provider}
      providerInfo={{ label, fields: [] }}
      conn={{ creds: {} }}
      customerResult={result}
      setCustomerResult={setResult}
      busy={(s) => busySection === s}
      wrap={async (section, fn, setter) => {
        setBusy(section);
        try {
          setter(await fn());
        } finally {
          setBusy('');
        }
      }}
    />
  );
}

const settle = <T,>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5000, interval: 50 });
const rowFor = (text: string) =>
  settle(() => {
    const el = [...document.querySelectorAll<HTMLButtonElement>('.roster-row')].find((b) =>
      b.textContent?.includes(text),
    );
    if (!el) throw new Error(`no row for ${text}`);
    return el;
  });
const hasRow = (text: string) =>
  [...document.querySelectorAll('.roster-row')].some((b) => b.textContent?.includes(text));

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
  resetSample();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Clients tab on the sample salon', { timeout: 30_000 }, () => {
  it('lists clients, then adds, edits and deletes one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await rowFor('Priya Raman');

    await user.click(screen.getByRole('button', { name: 'Add client' }));
    const form = screen.getByRole('form', { name: 'New client' });
    await user.type(within(form).getByLabelText('Name'), 'Lena Park');
    await user.type(within(form).getByLabelText('Email'), 'lena@example.com');
    await user.click(within(form).getByRole('button', { name: 'Add client' }));

    const edit = await settle(() => screen.getByRole('form', { name: 'Edit Lena Park' }));
    await user.type(within(edit).getByLabelText('Phone'), '+15550123');
    await user.type(within(edit).getByLabelText('Note'), 'Allergic to latex');
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await settle(async () => expect((await rowFor('Lena Park')).textContent).toContain('+15550123'));

    await user.click(screen.getByRole('button', { name: 'Delete client' }));
    expect(window.confirm).toHaveBeenCalled();
    await settle(() => expect(hasRow('Lena Park')).toBe(false));
  });

  it('opens a client by ID, and says so for an unknown one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await rowFor('Priya Raman');
    await user.type(screen.getByLabelText('Client ID'), 'cus_2');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await settle(() => screen.getByRole('form', { name: 'Edit Marcus Webb' }));

    await user.clear(screen.getByLabelText('Client ID'));
    await user.type(screen.getByLabelText('Client ID'), 'cus_404');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await settle(() => expect(screen.getByText(/No customer with id "cus_404"/)).toBeDefined());
  });

  it('a full email not in the loaded list searches the whole account', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const priya = await rowFor('Priya Raman');
    const email = priya.querySelector('[data-label="Email"]')!.textContent!.trim();
    await user.type(screen.getByLabelText(/Search clients/), 'nobody@nowhere.test');
    expect(screen.getByRole('button', { name: /Search all of Sample Salon/ })).toBeDefined();
    await user.clear(screen.getByLabelText(/Search clients/));
    await user.type(screen.getByLabelText(/Search clients/), email);
    expect(hasRow('Priya Raman')).toBe(true);
  });
});

describe('Clients tab follows the provider’s capabilities', () => {
  it('Setmore: explains it cannot list clients, keeps match-or-create', () => {
    render(<Harness provider="setmore" label="Setmore" />);
    expect(screen.getByText(/Setmore can't list or look up its clients/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Match or create' })).toBeDefined();
  });

  it('Phorest: loads on request and states that clients cannot be deleted', () => {
    render(<Harness provider="phorest" label="Phorest" />);
    expect(screen.getByRole('button', { name: 'Load clients' })).toBeDefined();
    expect(screen.getByText(/Phorest can't delete clients/)).toBeDefined();
  });

  it('Google: no client records at all', () => {
    render(<Harness provider="google" label="Google Calendar" />);
    expect(screen.getByText(/Google Calendar has no client records/)).toBeDefined();
  });
});
