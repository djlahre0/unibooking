/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingsTab from './BookingsTab';
import { callCreateBooking } from '../../lib/call';
import { __resetUiState } from '../../lib/ui-state';

vi.mock('../../lib/call', () => ({
  callCreateBooking: vi.fn(async () => ({ ok: true, data: { id: 'b1' } })),
  callGetBooking: vi.fn(),
  callUpdateBooking: vi.fn(),
  callCancelBooking: vi.fn(),
  callListBookings: vi.fn(),
}));

const create = vi.mocked(callCreateBooking);

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
  defaultRange: {
    start: '2026-09-14T00:00:00Z',
    end: '2026-10-12T00:00:00Z',
    slotStart: '2026-09-22T10:00:00Z',
    slotEnd: '2026-09-22T10:45:00Z',
  },
  bookingResult: null,
  setBookingResult: () => {},
  wrap,
  busy: () => false,
};

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
  create.mockClear();
});
afterEach(cleanup);

describe('Create Booking form', () => {
  it('is valid on first render — no hidden constraint blocks submission', () => {
    // A `step`/`min` mismatch or an unsatisfiable `required` makes a browser
    // refuse to submit with NO visible error and no console message, which is
    // exactly how the availability form silently broke.
    const { container } = render(<BookingsTab {...props} />);
    const form = container.querySelector('form')!;
    const invalid = Array.from(form.elements)
      .filter((el) => typeof (el as HTMLInputElement).checkValidity === 'function')
      .filter((el) => !(el as HTMLInputElement).checkValidity())
      .map((el) => (el as HTMLInputElement).name || (el as HTMLInputElement).id);
    expect(invalid).toEqual([]);
    expect(form.checkValidity()).toBe(true);
  });

  it('anchors the picked date and time in the chosen zone', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...props} />);
    const zone = screen.getByLabelText('Timezone (IANA)');
    await user.clear(zone);
    await user.type(zone, 'Asia/Kolkata');
    await user.click(screen.getByRole('button', { name: /Create Booking/ }));
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const input = create.mock.calls[0]![2];
    expect(input.start).toBe('2026-09-22T10:00:00+05:30');
    expect(input.end).toBe('2026-09-22T10:45:00+05:30');
  });

  it('sends UTC instants when the zone is UTC', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...props} />);
    const zone = screen.getByLabelText('Timezone (IANA)');
    await user.clear(zone);
    await user.type(zone, 'UTC');
    await user.click(screen.getByRole('button', { name: /Create Booking/ }));
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![2].start).toBe('2026-09-22T10:00:00Z');
  });
});
