/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Booking } from 'unibooking';

configure({ asyncUtilTimeout: 5000 });

// The selected calendar provider, in memory. Every call is recorded so the
// test can prove nothing but that one provider is ever reached.
const calls: { provider: string; op: string; args: Record<string, unknown> }[] = [];
const calendars = new Map<string, Booking[]>();
let nextEvent = 1;

vi.mock('../../lib/call', async (orig) => {
  const actual = await orig<typeof import('../../lib/call')>();
  return {
    ...actual,
    callOp: vi.fn(async (provider: string, _conn: unknown, op: string, args: Record<string, unknown>) => {
      calls.push({ provider, op, args });
      const id = String(args.calendarId ?? '');
      const events = calendars.get(id) ?? [];
      calendars.set(id, events);
      switch (op) {
        case 'listCalendars':
          return {
            ok: true,
            data: {
              calendars: [
                { id: 'mani', name: 'Manicure Cal', primary: false, readOnly: false, raw: {} },
                { id: 'pedi', name: 'Pedicure Cal', primary: false, readOnly: false, raw: {} },
                { id: 'hol', name: 'Holidays', primary: false, readOnly: true, raw: {} },
              ],
            },
          };
        case 'listBookings':
          return { ok: true, data: { bookings: events } };
        case 'createBooking': {
          const ev = {
            id: `ev${nextEvent++}`,
            title: String(args.title),
            description: String(args.description),
            range: { start: String(args.start), end: String(args.end) },
            status: 'confirmed',
          } as Booking;
          events.push(ev);
          return { ok: true, data: ev };
        }
        default:
          return { ok: true, data: {} };
      }
    }),
  };
});

import CalendarSyncTab from './CalendarSyncTab';

const google = () => (
  <CalendarSyncTab
    selectedProvider="google"
    providerInfo={{ label: 'Google Calendar', fields: [] }}
    conn={{ creds: {}, signedIn: true }}
  />
);

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  calendars.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Calendar Sync: your project <-> the selected calendar provider', { timeout: 30_000 }, () => {
  it('with Square selected, shows no calendars from anyone else', () => {
    render(
      <CalendarSyncTab
        selectedProvider="square"
        providerInfo={{ label: 'Square', fields: [] }}
        conn={{ creds: {} }}
      />,
    );
    expect(screen.getByText(/Square has no calendars/)).toBeTruthy();
    // No calendar panels, no calendar data, and no call to any provider.
    expect(screen.queryByRole('region', { name: 'Your project' })).toBeNull();
    expect(screen.queryByText(/Manicure Cal/)).toBeNull();
    expect(screen.queryByRole('button', { name: /calendars/ })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('links project services to Google calendars; a new project booking lands in its calendar', async () => {
    const user = userEvent.setup();
    render(google());

    await user.click(screen.getByRole('button', { name: 'Load demo salon' }));
    const project = screen.getByRole('region', { name: 'Your project' });
    expect(within(project).getByText('Manicure')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Load Google Calendar calendars' }));
    const right = await screen.findByRole('region', { name: 'Google Calendar calendars' });
    await within(right).findByText('Manicure Cal');
    // A read-only calendar can't be picked for bookings.
    expect(
      within(project).queryAllByRole('option', { name: 'Holidays' }),
    ).toHaveLength(0);

    await user.selectOptions(
      within(project).getByRole('combobox', { name: 'Calendar for Manicure' }),
      'Manicure Cal',
    );
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    await screen.findByText(/added to Google Calendar/);
    // The demo salon's manicures are now in Manicure Cal, with a marker.
    const mani = calendars.get('mani')!;
    expect(mani.length).toBeGreaterThan(0);
    expect(mani.every((e) => e.title.startsWith('Manicure'))).toBe(true);
    expect(mani[0]!.description).toMatch(/\[unibooking:project:pb_\d+\]/);

    // A booking made in the project shows up in the calendar straight away.
    const before = mani.length;
    await user.click(screen.getByRole('button', { name: 'New booking' }));
    const form = screen.getByRole('form', { name: 'New project booking' });
    await user.type(within(form).getByLabelText('Customer'), 'Lena');
    await user.click(within(form).getByRole('button', { name: 'Book in project' }));
    await vi.waitFor(() => expect(calendars.get('mani')!.length).toBe(before + 1));
    expect(calendars.get('mani')!.at(-1)!.title).toBe('Manicure · Lena');

    // Only Google was ever called.
    expect(new Set(calls.map((c) => c.provider))).toEqual(new Set(['google']));
  });

  it('events in a linked calendar that are not project bookings come back as busy time', async () => {
    const user = userEvent.setup();
    render(google());
    await user.click(screen.getByRole('button', { name: 'Load demo salon' }));
    calendars.set('pedi', [
      {
        id: 'x1',
        title: 'Staff training',
        range: { start: '2099-01-01T09:00:00Z', end: '2099-01-01T12:00:00Z' },
        status: 'confirmed',
      } as Booking,
    ]);
    // Within the sync window: tomorrow.
    const t = new Date(Date.now() + 86_400_000);
    calendars.get('pedi')![0]!.range = {
      start: t.toISOString(),
      end: new Date(t.getTime() + 3_600_000).toISOString(),
    };
    await user.click(screen.getByRole('button', { name: 'Load Google Calendar calendars' }));
    await screen.findByRole('region', { name: 'Google Calendar calendars' });
    await user.selectOptions(
      within(screen.getByRole('region', { name: 'Your project' })).getByRole('combobox', {
        name: 'Calendar for Pedicure',
      }),
      'Pedicure Cal',
    );
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    const busy = await screen.findByRole('region', { name: 'Busy time from Google Calendar' });
    expect(within(busy).getByText('Staff training')).toBeTruthy();
  });
});
