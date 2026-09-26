/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import BookingsTab from './BookingsTab';
import AvailabilityTab from './AvailabilityTab';
import { todayIn, shiftDate } from '../../lib/calendar/agenda';

/**
 * Every date default in the explorer must be computed from today, never
 * written into the source. A literal date is correct on the day it is typed
 * and drifts further into the past every day after: the Availability tab
 * still defaulted to 2026-07-20 two months later, so the first search ran
 * against a window the sample seed (today-7..today+21) does not cover and
 * came back empty.
 */
const today = todayIn('UTC');
const range = {
  start: `${shiftDate(today, -7)}T00:00:00Z`,
  end: `${shiftDate(today, 21)}T00:00:00Z`,
  dayStart: `${shiftDate(today, 1)}T00:00:00Z`,
  dayEnd: `${shiftDate(today, 2)}T00:00:00Z`,
  slotStart: `${shiftDate(today, 1)}T10:00:00Z`,
  slotEnd: `${shiftDate(today, 1)}T10:45:00Z`,
};

const shared = {
  selectedProvider: 'sample',
  providerInfo: { label: 'Sample Data' } as never,
  conn: { creds: {} },
  wrap: (async () => {}) as never,
  busy: () => false,
};

afterEach(cleanup);

function valuesOf(container: HTMLElement, type: 'date' | 'time'): string[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)).map(
    (el) => el.value,
  );
}

/** Date pickers must be on or after today, and look like real dates. */
function expectFreshDates(container: HTMLElement) {
  const dates = valuesOf(container, 'date');
  expect(dates.length).toBeGreaterThan(0);
  for (const value of dates) {
    expect(value, `${value} should be YYYY-MM-DD`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // ISO dates compare correctly as strings.
    expect(value >= today, `${value} is before today: a stale hardcoded default`).toBe(true);
  }
  for (const value of valuesOf(container, 'time')) {
    expect(value, `${value} should be HH:MM`).toMatch(/^\d{2}:\d{2}$/);
  }
}

describe('explorer date defaults', () => {
  it('Availability search opens on an upcoming day, not a literal date', () => {
    const { container } = render(
      <AvailabilityTab
        {...shared}
        defaultRange={range}
        availResult={null}
        setAvailResult={() => {}}
      />,
    );
    expectFreshDates(container);
    expect(valuesOf(container, 'date')).toEqual([shiftDate(today, 1), shiftDate(today, 2)]);
  });

  it('Create Booking opens on a concrete upcoming slot', () => {
    const { container } = render(
      <BookingsTab
        {...shared}
        defaultRange={range}
        bookingResult={null}
        setBookingResult={() => {}}
      />,
    );
    expectFreshDates(container);
    expect(valuesOf(container, 'time')).toEqual(['10:00', '10:45']);
  });

  it('the wide list window is still today-relative', () => {
    const { container } = render(
      <BookingsTab
        {...shared}
        defaultRange={range}
        bookingResult={null}
        setBookingResult={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    expect(valuesOf(container, 'date')).toEqual([shiftDate(today, -7), shiftDate(today, 21)]);
  });
});
