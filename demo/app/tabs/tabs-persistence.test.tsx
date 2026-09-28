/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingsTab from './BookingsTab';
import WebhooksTab from './WebhooksTab';
import { loadUiState, patchUiState, UI_KEY, __resetUiState } from '../../lib/ui-state';

const noop = (async () => {}) as never;

const bookingProps = {
  selectedProvider: 'sample',
  providerInfo: { label: 'Sample Data' } as never,
  conn: { creds: {} },
  defaultRange: {
    start: '2026-09-13T00:00:00Z',
    end: '2026-10-11T00:00:00Z',
    slotStart: '2026-09-22T10:00:00Z',
    slotEnd: '2026-09-22T10:45:00Z',
  },
  bookingResult: null,
  setBookingResult: () => {},
  wrap: noop,
  busy: () => false,
};

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
});
afterEach(cleanup);

describe('tab form persistence', () => {
  it('remembers what was typed into Create Booking', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...bookingProps} />);
    await user.type(screen.getByPlaceholderText('Jane Doe'), 'Ada Lovelace');
    await vi.waitFor(() =>
      expect(loadUiState().forms['bookings:create']?.customerName).toBe('Ada Lovelace'), { timeout: 4000 });
  });

  it('restores it on a remount', () => {
    patchUiState({ forms: { 'bookings:create': { customerName: 'Ada Lovelace' } } });
    render(<BookingsTab {...bookingProps} />);
    expect(screen.getByPlaceholderText<HTMLInputElement>('Jane Doe').value).toBe('Ada Lovelace');
  });

  it('keeps each booking op in its own slot', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...bookingProps} />);
    await user.type(screen.getByPlaceholderText('Jane Doe'), 'from-create');
    await vi.waitFor(() => expect(loadUiState().forms['bookings:create']).toBeTruthy(), { timeout: 4000 });
    // Switching op unmounts the create form and mounts another; the stored
    // slot for create must survive that.
    await user.click(screen.getByRole('button', { name: /Get/ }));
    expect(loadUiState().forms['bookings:create']?.customerName).toBe('from-create');
  });

  it('remembers the webhook PROVIDER', async () => {
    const user = userEvent.setup();
    render(
      <WebhooksTab
        webhookResult={null}
        setWebhookResult={() => {}}
        wrap={noop}
        busy={() => false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Acuity' }));
    await vi.waitFor(() => expect(loadUiState().webhookProvider).toBe('acuity'), { timeout: 4000 });
  });

  it('never writes a webhook signing secret to storage', async () => {
    const user = userEvent.setup();
    render(
      <WebhooksTab
        webhookResult={null}
        setWebhookResult={() => {}}
        wrap={noop}
        busy={() => false}
      />,
    );
    await user.type(
      screen.getByPlaceholderText('Webhook signature key'),
      'super-secret-hmac-value',
    );
    // Give any debounced writer more than its 300ms window to misbehave.
    await new Promise((r) => setTimeout(r, 450));
    expect(localStorage.getItem(UI_KEY) ?? '').not.toContain('super-secret-hmac-value');
  });
});
