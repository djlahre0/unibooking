/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MappingTab from './MappingTab';
import type { ActionResult } from '../../lib/call';
import { __resetUiState } from '../../lib/ui-state';
import { resetSample } from '../../lib/sample/store';

function Harness({ provider = 'sample', label = 'Sample Salon' }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busySection, setBusy] = useState('');
  return (
    <MappingTab
      selectedProvider={provider}
      providerInfo={{ label, fields: [] }}
      conn={{ creds: {} }}
      result={result}
      setResult={setResult}
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
const project = () => screen.getByRole('region', { name: 'Your project' });
const providerSide = () => screen.getByRole('region', { name: 'Sample Salon' });
const rowIn = (side: HTMLElement, text: string) => {
  const li = within(side)
    .getAllByRole('listitem')
    .find((el) => el.textContent?.includes(text));
  if (!li) throw new Error(`no row for ${text}`);
  return li;
};

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

describe('Mapping: project records ↔ the connected provider', { timeout: 30_000 }, () => {
  it('loading the provider shows its records on their own side, merging nothing', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Load Sample Salon staff' }));
    await settle(() => rowIn(providerSide(), 'Ava Mitchell'));
    expect(within(providerSide()).getAllByRole('listitem')).toHaveLength(4);
    // The project side is untouched.
    expect(within(project()).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('auto-match links by email; link-to and import are explicit per record', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // A record the project already has, with the same email as a provider one.
    await user.click(screen.getByRole('button', { name: 'Add a project staff member' }));
    const form = screen.getByRole('form', { name: 'New project record' });
    await user.type(within(form).getByLabelText('Name'), 'Ava M.');
    await user.type(within(form).getByLabelText('Email'), 'ava@example.salon');
    await user.click(within(form).getByRole('button', { name: 'Add to project' }));
    await user.click(screen.getByRole('button', { name: 'Add a project staff member' }));
    const form2 = screen.getByRole('form', { name: 'New project record' });
    await user.type(within(form2).getByLabelText('Name'), 'Benny');
    await user.click(within(form2).getByRole('button', { name: 'Add to project' }));

    await user.click(screen.getByRole('button', { name: /Auto-match/ }));
    await settle(() =>
      expect(rowIn(project(), 'Ava Mitchell').textContent).toContain('Linked'),
    );
    // Auto-match only links: nothing imported.
    expect(within(project()).getAllByRole('listitem')).toHaveLength(2);

    // Benny has no email: link him by hand.
    await settle(() => rowIn(providerSide(), 'Ben Okafor'));
    await user.selectOptions(
      within(rowIn(providerSide(), 'Ben Okafor')).getByRole('combobox'),
      'Benny',
    );
    await settle(() => expect(rowIn(providerSide(), 'Ben Okafor').textContent).toContain('← Ben Okafor'));

    // Import one provider record on purpose.
    await user.click(
      within(rowIn(providerSide(), 'Chloe Duarte')).getByRole('button', { name: 'Import to project' }),
    );
    expect(rowIn(project(), 'Chloe Duarte').textContent).toContain('Linked');
    expect(within(project()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('a project edit is flagged, then Sync linked sends it to the provider', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Load Sample Salon staff' }));
    await settle(() => rowIn(providerSide(), 'Dan Reyes'));
    await user.click(
      within(rowIn(providerSide(), 'Dan Reyes')).getByRole('button', { name: 'Import to project' }),
    );
    await user.click(within(rowIn(project(), 'Dan Reyes')).getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('form', { name: 'Edit project record Dan Reyes' });
    const name = within(edit).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Daniel Reyes');
    await user.click(within(edit).getByRole('button', { name: 'Save in project' }));
    expect(rowIn(project(), 'Daniel Reyes').textContent).toContain('Changed in project');

    await user.click(screen.getByRole('button', { name: 'Sync linked' }));
    await settle(() => expect(screen.getByText(/1 sent to Sample Salon/)).toBeDefined());
    expect(rowIn(project(), 'Daniel Reyes').textContent).toContain('Linked');
    expect(rowIn(providerSide(), 'Daniel Reyes').textContent).toContain('← Daniel Reyes');
  });

  it('unlink separates the pair again without deleting either side', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Load Sample Salon staff' }));
    await settle(() => rowIn(providerSide(), 'Ava Mitchell'));
    await user.click(
      within(rowIn(providerSide(), 'Ava Mitchell')).getByRole('button', { name: 'Import to project' }),
    );
    await user.click(within(rowIn(project(), 'Ava Mitchell')).getByRole('button', { name: 'Unlink' }));
    expect(rowIn(project(), 'Ava Mitchell').textContent).toContain('Not linked');
    expect(rowIn(providerSide(), 'Ava Mitchell').textContent).toContain('Not linked');
  });

  it('Google has nothing to map', () => {
    render(<Harness provider="google" label="Google Calendar" />);
    expect(screen.getByText(/Google Calendar has no staff or services to map/)).toBeDefined();
  });
});
