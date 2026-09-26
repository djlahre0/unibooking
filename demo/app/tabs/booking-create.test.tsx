/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingsTab from './BookingsTab';
import {
  callCancelBooking,
  callMarkCancelled,
  callCreateBooking,
  callListBookings,
  callListCalendars,
  callUpdateBooking,
  providerCapabilities,
} from '../../lib/call';
import { __resetUiState } from '../../lib/ui-state';
import { targetCalendar } from './useCalendarZone';

vi.mock('../../lib/call', () => ({
  callCreateBooking: vi.fn(async () => ({ ok: true, data: { id: 'b1' } })),
  callGetBooking: vi.fn(),
  callUpdateBooking: vi.fn(async () => ({ ok: true, data: { id: 'b1' } })),
  callCancelBooking: vi.fn(async () => ({ ok: true, data: { cancelled: true } })),
  callMarkCancelled: vi.fn(async () => ({ ok: true, data: { id: 'b1' } })),
  callListBookings: vi.fn(async () => ({ ok: true, data: { bookings: [] } })),
  callListCalendars: vi.fn(),
  // Google by default reports no calendar list here, so the browser zone is
  // the fallback; the calendar-zone tests below switch it on.
  providerCapabilities: vi.fn(() => ({ calendarList: false })),
}));

const create = vi.mocked(callCreateBooking);
const update = vi.mocked(callUpdateBooking);
const list = vi.mocked(callListBookings);
const listCalendars = vi.mocked(callListCalendars);
const capabilities = vi.mocked(providerCapabilities);
const cancel = vi.mocked(callCancelBooking);
const markCancelled = vi.mocked(callMarkCancelled);

// Same contract as page.tsx's wrap: a throw becomes an error result.
const wrap = (async (
  _section: string,
  fn: () => Promise<unknown>,
  setter: (r: unknown) => void,
) => {
  try {
    setter(await fn());
  } catch (e) {
    setter({ ok: false, error: { message: String(e) } });
  }
}) as never;

const props = {
  selectedProvider: 'google',
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
  update.mockClear();
  cancel.mockClear();
  markCancelled.mockClear();
  list.mockClear();
  listCalendars.mockReset();
  capabilities.mockImplementation(() => ({ calendarList: false }) as never);
});
afterEach(cleanup);

describe('Create Booking form', () => {
  it('is valid on first render, no hidden constraint blocks submission', () => {
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
    const zone = screen.getByLabelText('Timezone override (IANA)');
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
    const zone = screen.getByLabelText('Timezone override (IANA)');
    await user.clear(zone);
    await user.type(zone, 'UTC');
    await user.click(screen.getByRole('button', { name: /Create Booking/ }));
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![2].start).toBe('2026-09-22T10:00:00Z');
  });
});

describe('picked times follow the calendar zone', () => {
  const calendars = (timezone: string) => ({
    ok: true as const,
    data: {
      calendars: [
        {
          id: 'other@x',
          name: 'Other',
          timezone: 'America/New_York',
          primary: false,
          readOnly: false,
        },
        { id: 'me@x', name: 'Work', timezone, primary: true, readOnly: false, raw: {} },
      ],
    },
  });

  it("anchors a create in the primary calendar's zone and says so", async () => {
    capabilities.mockImplementation(() => ({ calendarList: true }) as never);
    listCalendars.mockResolvedValue(calendars('Asia/Kolkata'));
    const user = userEvent.setup();
    render(<BookingsTab {...props} />);
    await screen.findByText(/Asia\/Kolkata, the time zone of "Work"/);
    await user.click(screen.getByRole('button', { name: /Create Booking/ }));
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![2].start).toBe('2026-09-22T10:00:00+05:30');
  });

  it('uses the calendar the credentials target, not the primary one', async () => {
    capabilities.mockImplementation(() => ({ calendarList: true }) as never);
    listCalendars.mockResolvedValue(calendars('Asia/Kolkata'));
    render(<BookingsTab {...props} conn={{ creds: { calendarId: 'other@x' } }} />);
    await screen.findByText(/America\/New_York, the time zone of "Other"/);
  });

  it('falls back to the browser zone when the lookup fails', async () => {
    capabilities.mockImplementation(() => ({ calendarList: true }) as never);
    listCalendars.mockResolvedValue({ ok: false, error: { message: 'no token' } });
    render(<BookingsTab {...props} />);
    await screen.findByText(/this browser's time zone/);
  });

  it('update sends zoned instants from the pickers, and nothing when left blank', async () => {
    capabilities.mockImplementation(() => ({ calendarList: true }) as never);
    listCalendars.mockResolvedValue(calendars('Asia/Kolkata'));
    const user = userEvent.setup();
    render(<BookingsTab {...props} />);
    await user.click(screen.getByRole('button', { name: /Update/ }));
    await screen.findByText(/Asia\/Kolkata/);
    await user.type(screen.getByLabelText('Booking ID'), 'b1');
    await user.click(screen.getByRole('button', { name: /Update Booking/ }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![3]).toMatchObject({ start: undefined, end: undefined });

    await user.type(screen.getByLabelText('New start date'), '2026-10-01');
    await user.type(screen.getByLabelText('New start time'), '09:30');
    await user.type(screen.getByLabelText('New end date'), '2026-10-01');
    await user.type(screen.getByLabelText('New end time'), '10:30');
    await user.click(screen.getByRole('button', { name: /Update Booking/ }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![3]).toMatchObject({
      start: '2026-10-01T09:30:00+05:30',
      end: '2026-10-01T10:30:00+05:30',
    });
  });

  it('list converts its window through the override zone when one is typed', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...props} />);
    await user.click(screen.getByRole('button', { name: /List/ }));
    await user.type(screen.getByLabelText('Timezone override (IANA)'), 'UTC');
    await user.click(screen.getByRole('button', { name: /List Bookings/ }));
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]![2]).toMatchObject({
      start: '2026-09-14T00:00:00Z',
      end: '2026-10-12T00:00:00Z',
    });
  });
});

describe('targetCalendar', () => {
  const cals = [
    { id: 'work@x', name: 'Work', primary: true, readOnly: false, raw: {} },
    { id: 'team@x', name: 'Team', primary: false, readOnly: false, raw: {} },
  ];

  it('prefers the calendarId the credentials name', () => {
    expect(targetCalendar(cals, { creds: { calendarId: 'team@x' } })?.name).toBe('Team');
  });

  it("treats Google's 'primary' alias and a blank id as the primary calendar", () => {
    expect(targetCalendar(cals, { creds: { calendarId: 'primary' } })?.name).toBe('Work');
    expect(targetCalendar(cals, { creds: {} })?.name).toBe('Work');
  });

  it('never substitutes the primary calendar for an id it cannot find', () => {
    expect(targetCalendar(cals, { creds: { calendarId: 'gone@x' } })).toBeUndefined();
  });

  it('ignores a pasted calendarId once signed in, since the session books into the primary', () => {
    expect(targetCalendar(cals, { creds: { calendarId: 'team@x' }, signedIn: true })?.name).toBe(
      'Work',
    );
  });
});

describe('bad picker input is reported, not sent', () => {
  it('rejects a typo in the zone override', async () => {
    const setBookingResult = vi.fn();
    const user = userEvent.setup();
    render(<BookingsTab {...props} setBookingResult={setBookingResult} />);
    await user.type(screen.getByLabelText('Timezone override (IANA)'), 'Asia/Kolkatta');
    await user.click(screen.getByRole('button', { name: /Create Booking/ }));
    await vi.waitFor(() => expect(setBookingResult).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a new time with no date on update', async () => {
    const setBookingResult = vi.fn();
    const user = userEvent.setup();
    render(<BookingsTab {...props} setBookingResult={setBookingResult} />);
    await user.click(screen.getByRole('button', { name: /Update/ }));
    await user.type(screen.getByLabelText('Booking ID'), 'b1');
    await user.type(screen.getByLabelText('New start time'), '09:30');
    await user.click(screen.getByRole('button', { name: /Update Booking/ }));
    await vi.waitFor(() =>
      expect(setBookingResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false })),
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe('cancel vs delete', () => {
  it('a calendar provider offers both; Cancel keeps the event, Delete removes it', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...props} />);

    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await user.type(screen.getByLabelText('Booking ID'), 'e1');
    await user.type(screen.getByLabelText('Reason'), 'Room gone');
    await user.click(screen.getByRole('button', { name: /Cancel Event/ }));
    await vi.waitFor(() => expect(markCancelled).toHaveBeenCalled());
    expect(markCancelled.mock.calls[0]!.slice(2)).toEqual(['e1', 'Room gone']);
    expect(cancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await user.type(screen.getByLabelText('Booking ID'), 'e2');
    // Permanent, so it asks first; declining sends nothing.
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /Delete Event/ }));
    expect(ask).toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    ask.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Delete Event/ }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(cancel.mock.calls[0]![2]).toBe('e2');
    ask.mockRestore();
  });

  it('update offers a status: calendar statuses on a calendar, platform ones elsewhere', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...props} />);
    await user.click(screen.getByRole('button', { name: /^Update$/ }));
    const select = screen.getByLabelText('New Status') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual([
      'Leave unchanged',
      'Confirmed',
      'Tentative',
      'Cancelled',
    ]);
    await user.type(screen.getByLabelText('Booking ID'), 'e7');
    await user.selectOptions(select, 'Tentative');
    await user.click(screen.getByRole('button', { name: /Update Booking/ }));
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![3]).toMatchObject({ status: 'pending' });
    cleanup();

    render(<BookingsTab {...props} selectedProvider="square" />);
    await user.click(screen.getByRole('button', { name: /^Update$/ }));
    expect(
      [...(screen.getByLabelText('New Status') as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual(['', 'confirmed', 'pending', 'completed', 'no_show']);
  });

  it('a booking platform keeps its single Cancel, which is the real cancelBooking', async () => {
    const user = userEvent.setup();
    render(<BookingsTab {...props} selectedProvider="square" />);
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await user.type(screen.getByLabelText('Booking ID'), 'b9');
    await user.click(screen.getByRole('button', { name: /Cancel Booking/ }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(markCancelled).not.toHaveBeenCalled();
  });
});
