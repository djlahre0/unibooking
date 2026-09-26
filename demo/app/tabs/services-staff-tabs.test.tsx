/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ServicesTab from './ServicesTab';
import StaffTab from './StaffTab';
import type { ActionResult } from '../../lib/call';
import { __resetUiState } from '../../lib/ui-state';
import { resetSample } from '../../lib/sample/store';

/** A tab plus the result/busy state page.tsx would hold, over the REAL sample
 *  provider -- every click below is a genuine round trip through dispatch(). */
function Harness({
  tab,
  provider = 'sample',
  label = 'Sample Salon',
}: {
  tab: 'services' | 'staff';
  provider?: string;
  label?: string;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busySection, setBusy] = useState('');
  const props = {
    selectedProvider: provider,
    providerInfo: { label, fields: [] },
    conn: { creds: {} },
    result,
    setResult,
    busy: (s: string) => busySection === s,
    wrap: async (
      section: string,
      fn: () => Promise<ActionResult>,
      setter: (r: ActionResult) => void,
    ) => {
      setBusy(section);
      try {
        setter(await fn());
      } finally {
        setBusy('');
      }
    },
  };
  return tab === 'services' ? <ServicesTab {...props} /> : <StaffTab {...props} />;
}

/** Each sample call takes ~150 ms plus a render. */
const settle = <T,>(fn: () => Promise<T> | T) => vi.waitFor(fn, { timeout: 5000, interval: 50 });

/** The row button for a name, once the list has loaded. */
const row = (name: string) =>
  settle(() => {
    const el = screen
      .getAllByRole('button', { expanded: false })
      .concat(screen.queryAllByRole('button', { expanded: true }))
      .find((b) => b.classList.contains('roster-row') && b.textContent?.includes(name));
    if (!el) throw new Error(`no row for ${name}`);
    return el;
  });

const hasRow = (name: string) =>
  [...document.querySelectorAll('.roster-row')].some((b) => b.textContent?.includes(name));

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

describe('Services tab on the sample salon', { timeout: 30_000 }, () => {
  it('shows the catalog straight away, with who performs each service', async () => {
    render(<Harness tab="services" />);
    const haircut = await row('Haircut');
    // Every active stylist is seeded onto every service: three sets of initials.
    expect(haircut.querySelectorAll('.roster-mark')).toHaveLength(3);
    expect(haircut.textContent).toContain('30 min');
    expect(screen.getByText(/6 in Sample Salon/)).toBeDefined();
  });

  it('adds, edits, deactivates and deletes a service from its row', async () => {
    const user = userEvent.setup();
    render(<Harness tab="services" />);
    await row('Haircut');

    await user.click(screen.getByRole('button', { name: 'Add service' }));
    const form = screen.getByRole('form', { name: 'New service' });
    await user.type(within(form).getByLabelText('Name'), 'Brow shaping');
    await user.type(within(form).getByLabelText('Length (minutes)'), '20');
    await user.type(within(form).getByLabelText('Price'), '15.50');
    // The currency is pre-filled from the rest of the catalog.
    expect((within(form).getByLabelText('Currency') as HTMLInputElement).value).toBe('USD');
    await user.click(within(form).getByRole('button', { name: 'Create service' }));

    // The new service is added and opened for editing.
    const edit = await settle(() => screen.getByRole('form', { name: 'Edit Brow shaping' }));
    expect((await row('Brow shaping')).textContent).toMatch(/15\.50/);

    const name = within(edit).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Brow sculpt');
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await settle(() => expect(hasRow('Brow sculpt')).toBe(true));
    // A partial update: the price was not sent, so it is still there.
    expect((await row('Brow sculpt')).textContent).toMatch(/15\.50/);

    // Status is saved with the rest of the row: updateService({ active }).
    const edited = screen.getByRole('form', { name: 'Edit Brow sculpt' });
    await user.selectOptions(within(edited).getByLabelText('Status'), 'inactive');
    await user.click(within(edited).getByRole('button', { name: 'Save changes' }));
    await settle(async () => expect((await row('Brow sculpt')).textContent).toContain('Inactive'));
    expect(window.confirm).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete service' }));
    await settle(() => expect(hasRow('Brow sculpt')).toBe(false));
  });

  it('ticking a stylist assigns them; unticking removes them', async () => {
    const user = userEvent.setup();
    render(<Harness tab="services" />);
    await user.click(await row('Facial'));
    const dan = screen.getByRole('checkbox', { name: /Dan Reyes/ });
    expect((dan as HTMLInputElement).checked).toBe(false);

    await user.click(dan);
    await settle(() =>
      expect((screen.getByRole('checkbox', { name: /Dan Reyes/ }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect((await row('Facial')).querySelectorAll('.roster-mark')).toHaveLength(4);

    await user.click(screen.getByRole('checkbox', { name: /Dan Reyes/ }));
    await settle(async () =>
      expect((await row('Facial')).querySelectorAll('.roster-mark')).toHaveLength(3),
    );
  });

  it('filters by performer, searches by name, and looks up an unknown ID', async () => {
    const user = userEvent.setup();
    render(<Harness tab="services" />);
    await row('Haircut');

    // Dan (inactive) performs nothing yet.
    await user.selectOptions(screen.getByLabelText('Performed by'), 'Performed by Dan Reyes');
    expect(hasRow('Haircut')).toBe(false);
    expect(screen.getByText(/Dan Reyes doesn't perform/)).toBeDefined();
    await user.selectOptions(screen.getByLabelText('Performed by'), 'Performed by anyone');

    await user.type(screen.getByLabelText(/Search services/), 'colo');
    expect(hasRow('Colour')).toBe(true);
    expect(hasRow('Haircut')).toBe(false);

    await user.clear(screen.getByLabelText(/Search services/));
    await user.type(screen.getByLabelText(/Search services/), 'svc_nope');
    await user.click(screen.getByRole('button', { name: /Look up “svc_nope” by ID/ }));
    await settle(() => expect(screen.getByText(/No service with id "svc_nope"/)).toBeDefined());
  });
});

describe('Staff tab on the sample salon', { timeout: 30_000 }, () => {
  it('adds, deactivates and deletes a staff member', async () => {
    const user = userEvent.setup();
    render(<Harness tab="staff" />);
    await row('Ava Mitchell');

    await user.click(screen.getByRole('button', { name: 'Add staff member' }));
    const form = screen.getByRole('form', { name: 'New staff member' });
    await user.type(within(form).getByLabelText('Name'), 'Remy Ortiz');
    await user.type(within(form).getByLabelText('Email'), 'remy@example.salon');
    await user.click(within(form).getByRole('button', { name: 'Add staff member' }));
    await settle(async () => expect((await row('Remy Ortiz')).textContent).toContain('remy@'));

    const edit = screen.getByRole('form', { name: 'Edit Remy Ortiz' });
    // Name and status in one save.
    const name = within(edit).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Remy O.');
    await user.selectOptions(within(edit).getByLabelText('Status'), 'inactive');
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await settle(async () => expect((await row('Remy O.')).textContent).toContain('Inactive'));

    await user.click(screen.getByRole('button', { name: 'Delete staff member' }));
    await settle(() => expect(hasRow('Remy O.')).toBe(false));
  });

  it('shows what each person performs, and ticking a service assigns it', async () => {
    const user = userEvent.setup();
    render(<Harness tab="staff" />);
    expect((await row('Ava Mitchell')).textContent).toContain('6 of 6 services');
    expect((await row('Dan Reyes')).textContent).toContain('Nothing yet');

    await user.click(await row('Dan Reyes'));
    await user.click(screen.getByRole('checkbox', { name: /Haircut/ }));
    await settle(async () =>
      expect((await row('Dan Reyes')).textContent).toContain('1 of 6 services'),
    );
  });

  it('declining the deactivate prompt saves nothing', async () => {
    const user = userEvent.setup();
    render(<Harness tab="staff" />);
    await user.click(await row('Ava Mitchell'));
    vi.mocked(window.confirm).mockReturnValue(false);
    const edit = screen.getByRole('form', { name: 'Edit Ava Mitchell' });
    await user.selectOptions(within(edit).getByLabelText('Status'), 'inactive');
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
    expect(window.confirm).toHaveBeenCalled();
    expect((await row('Ava Mitchell')).textContent).toContain('Active');
  });

  it('by ID: open, update and delete one staff member', async () => {
    const user = userEvent.setup();
    render(<Harness tab="staff" />);
    await row('Ben Okafor');

    await user.type(screen.getByLabelText('Staff member ID'), 'stf_2');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const edit = await settle(() => screen.getByRole('form', { name: 'Edit Ben Okafor' }));

    const email = within(edit).getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'ben.o@example.salon');
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await settle(async () =>
      expect((await row('Ben Okafor')).textContent).toContain('ben.o@example.salon'),
    );

    await user.click(screen.getByRole('button', { name: 'Delete staff member' }));
    await settle(() => expect(hasRow('Ben Okafor')).toBe(false));
  });

  it('by ID: an unknown ID says so', async () => {
    const user = userEvent.setup();
    render(<Harness tab="staff" />);
    await row('Ben Okafor');
    await user.type(screen.getByLabelText('Staff member ID'), 'stf_404');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await settle(() => expect(screen.getByText(/No staff member with id "stf_404"/)).toBeDefined());
  });

  it('filters by status', async () => {
    const user = userEvent.setup();
    render(<Harness tab="staff" />);
    await row('Ava Mitchell');
    await user.selectOptions(screen.getByLabelText('Status'), 'inactive');
    expect(hasRow('Dan Reyes')).toBe(true);
    expect(hasRow('Ava Mitchell')).toBe(false);
  });
});

describe('each tab follows the provider’s capabilities', () => {
  it('Square: reads only on request, warns that writes are real, and cannot delete staff', () => {
    render(<Harness tab="staff" provider="square" label="Square" />);
    expect(screen.getByRole('button', { name: 'Load staff' })).toBeDefined();
    expect(screen.getByRole('note').textContent).toMatch(/real Square account/);
    expect(screen.getByText(/Square can't delete staff/)).toBeDefined();
  });

  it('Microsoft Bookings: no Status field for staff, which have no inactive state', async () => {
    // The dispatch layer would refuse it anyway (UNSUPPORTED from defineAdapter).
    render(<Harness tab="staff" provider="microsoft_bookings" label="Microsoft Bookings" />);
    expect(screen.getByText(/can't deactivate staff \(delete them instead\)/)).toBeDefined();
  });

  it('Google: explains there is no catalog instead of showing empty controls', () => {
    render(<Harness tab="services" provider="google" label="Google Calendar" />);
    expect(screen.getByText(/Google Calendar has no service catalog/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Load services/ })).toBeNull();
  });
});
