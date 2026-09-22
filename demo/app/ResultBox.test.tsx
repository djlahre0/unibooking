/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ResultBox from './ResultBox';

// vitest.config.ts runs without `globals: true`, so cleanup is not automatic
// between tests in this file (see ConnectPanel.test.tsx for the same pattern).
afterEach(cleanup);

const bookingsResult = {
  ok: true,
  data: {
    bookings: [
      {
        id: 'b1',
        title: 'Haircut — Priya Raman',
        range: { start: '2026-09-13T09:00:00-07:00', end: '2026-09-13T09:30:00-07:00' },
        customer: { name: 'Priya Raman' },
        staffId: 'staff-1',
        status: 'confirmed',
      },
      {
        id: 'b2',
        title: 'Colour — Marcus Webb',
        range: { start: '2026-09-14T10:00:00-07:00', end: '2026-09-14T11:00:00-07:00' },
        customer: { name: 'Marcus Webb' },
        staffId: 'staff-2',
        status: 'pending',
      },
    ],
  },
};

describe('ResultBox with a bookings payload', () => {
  it('renders a schedule grouped by day instead of dumping JSON', () => {
    render(<ResultBox result={bookingsResult} label="list result" />);

    // Start time, title, customer, staff and status -- the columns the
    // design system calls out for the schedule view.
    expect(screen.getByText('09:00')).toBeDefined();
    expect(screen.getByText('Haircut — Priya Raman')).toBeDefined();
    expect(screen.getByText('Priya Raman')).toBeDefined();
    expect(screen.getByText('staff-1')).toBeDefined();
    expect(screen.getByText('confirmed')).toBeDefined();

    // Two bookings on different days produce two day headings, each a quiet
    // row heading rather than part of the row itself.
    expect(screen.getByText('Sun, 13 Sep')).toBeDefined();
    expect(screen.getByText('Mon, 14 Sep')).toBeDefined();
  });

  it('collapses the raw JSON disclosure by default', () => {
    const { container } = render(<ResultBox result={bookingsResult} label="list result" />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(screen.getByText('Raw JSON')).toBeDefined();
  });
});

describe('ResultBox with a failed result', () => {
  it('shows the error code and whether it is retryable', () => {
    render(
      <ResultBox
        result={{
          ok: false,
          error: { code: 'RATE_LIMIT', message: 'Too many requests.', retryable: true },
        }}
        label="list result"
      />,
    );
    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText('RATE_LIMIT')).toBeDefined();
    expect(screen.getByText('Retryable')).toBeDefined();
    expect(screen.getByText('Too many requests.')).toBeDefined();
  });

  it('marks a non-retryable error as such', () => {
    render(
      <ResultBox
        result={{
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'Missing serviceId.', retryable: false },
        }}
        label="list result"
      />,
    );
    expect(screen.getByText('Not retryable')).toBeDefined();
  });
});
