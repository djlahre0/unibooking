/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AvailabilityTab from './AvailabilityTab';
import { callSearchAvailability } from '../../lib/call';
import { __resetUiState } from '../../lib/ui-state';

vi.mock('../../lib/call', () => ({
  callSearchAvailability: vi.fn(async () => ({ ok: true, data: { slots: [] } })),
}));

const search = vi.mocked(callSearchAvailability);

/** Runs the op for real so the submit handler's output is what we inspect. */
const wrap = (async (
  _section: string,
  fn: () => Promise<unknown>,
  setter: (r: unknown) => void,
) => {
  setter(await fn());
}) as never;

const props = {
  selectedProvider: 'google',
  providerInfo: { label: 'Google Calendar' } as never,
  conn: { creds: {} },
  defaultRange: { dayStart: '2026-09-22T00:00:00Z', dayEnd: '2026-09-23T00:00:00Z' },
  availResult: null,
  setAvailResult: () => {},
  wrap,
  busy: () => false,
};

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
  search.mockClear();
});
afterEach(cleanup);

async function submitWith(tz: string) {
  const user = userEvent.setup();
  render(<AvailabilityTab {...props} />);
  const zone = screen.getByLabelText('Timezone (IANA)');
  await user.clear(zone);
  await user.type(zone, tz);
  await user.click(screen.getByRole('button', { name: /Search Slots/ }));
  await vi.waitFor(() => expect(search).toHaveBeenCalled());
  return search.mock.calls[0]![2];
}

describe('Availability query built from the pickers', () => {
  it('sends a positive durationMinutes — the field Google rejected the query without', async () => {
    // The reported failure: "[google] INVALID_INPUT: Google freeBusy returns
    // busy intervals only; pass a positive durationMinutes to size each slot".
    const query = await submitWith('UTC');
    expect(query.durationMinutes).toBe(30);
  });

  it('anchors the picked date and time in the chosen zone', async () => {
    const query = await submitWith('Asia/Kolkata');
    expect(query.start).toBe('2026-09-22T00:00:00+05:30');
    expect(query.end).toBe('2026-09-23T00:00:00+05:30');
    expect(query.timezone).toBe('Asia/Kolkata');
  });

  it('sends UTC instants when the zone is UTC', async () => {
    const query = await submitWith('UTC');
    expect(query.start).toBe('2026-09-22T00:00:00Z');
    expect(query.end).toBe('2026-09-23T00:00:00Z');
  });

  it('omits durationMinutes when the visitor clears it, rather than sending 0', async () => {
    const user = userEvent.setup();
    render(<AvailabilityTab {...props} />);
    await user.clear(screen.getByLabelText('Slot length (minutes)'));
    await user.click(screen.getByRole('button', { name: /Search Slots/ }));
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    expect(search.mock.calls[0]![2]).not.toHaveProperty('durationMinutes');
  });

  it('fills the timezone from the browser when left untouched', async () => {
    render(<AvailabilityTab {...props} />);
    const zone = screen.getByLabelText<HTMLInputElement>('Timezone (IANA)');
    await vi.waitFor(() => expect(zone.value).not.toBe(''));
  });
});
