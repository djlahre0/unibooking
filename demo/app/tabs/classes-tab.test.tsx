/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClassesTab from './ClassesTab';
import type { ActionResult } from '../../lib/call';

afterEach(cleanup);

const range = { start: '2026-09-14T00:00:00Z', end: '2026-10-12T00:00:00Z' };

function props(over: Record<string, unknown> = {}) {
  return {
    selectedProvider: 'mindbody',
    providerInfo: { label: 'Mindbody' } as never,
    conn: { creds: {} } as never,
    defaultRange: range,
    classesResult: null as ActionResult | null,
    setClassesResult: () => {},
    wrap: (async () => {}) as never,
    busy: () => false,
    ...over,
  };
}

/** A listClasses payload shaped the way the wire delivers it. */
function listed(classes: unknown[]): ActionResult {
  return { ok: true, data: { classes } } as ActionResult;
}

const openClass = {
  id: '501',
  title: 'Vinyasa Flow',
  range: { start: '2030-06-12T01:00:00Z', end: '2030-06-12T02:00:00Z' },
  capacity: 20,
  booked: 12,
  available: 8,
  full: false,
  status: 'scheduled',
};

describe('ClassesTab', () => {
  it('tells the visitor when the provider has no class concept, instead of showing a dead form', () => {
    render(<ClassesTab {...props({ selectedProvider: 'google', providerInfo: { label: 'Google' } })} />);
    expect(screen.getByText(/has no group-class concept/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /List Classes/i })).toBeNull();
  });

  it('renders the class form for a provider that supports classes', () => {
    render(<ClassesTab {...props()} />);
    expect(screen.getByRole('button', { name: /List Classes/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Enroll/i })).toBeTruthy();
  });

  it('shows capacity for an open class and marks a full one', () => {
    const { rerender } = render(
      <ClassesTab {...props({ classesResult: listed([openClass]) })} />,
    );
    expect(screen.getByText('12/20')).toBeTruthy();

    // Full with no waitlist room reads as "full", not as a capacity count.
    rerender(
      <ClassesTab
        {...props({
          classesResult: listed([{ ...openClass, booked: 20, available: 0, full: true }]),
        })}
      />,
    );
    expect(screen.getByText('full')).toBeTruthy();
  });

  it('distinguishes a full class with waitlist room from one without', () => {
    render(
      <ClassesTab
        {...props({
          classesResult: listed([
            {
              ...openClass,
              full: true,
              booked: 20,
              waitlistCapacity: 5,
              waitlistCount: 1,
            },
          ]),
        })}
      />,
    );
    expect(screen.getByText('waitlist')).toBeTruthy();
  });

  it('trusts `full` over the numbers when they disagree', () => {
    // Spots remain but the provider closed the class. Showing "12/20" here
    // would invite an enroll that can only ever CONFLICT.
    render(
      <ClassesTab {...props({ classesResult: listed([{ ...openClass, full: true }]) })} />,
    );
    expect(screen.queryByText('12/20')).toBeNull();
    expect(screen.getByText('full')).toBeTruthy();
  });

  it('labels a cancelled class as cancelled rather than by capacity', () => {
    render(
      <ClassesTab
        {...props({ classesResult: listed([{ ...openClass, status: 'cancelled' }]) })}
      />,
    );
    expect(screen.getByText('cancelled')).toBeTruthy();
  });

  it('sends the picked class id when enrolling, in preference to the text field', async () => {
    const user = userEvent.setup();
    const wrap = vi.fn(async (_s: string, fn: () => Promise<unknown>) => {
      await fn();
    });
    render(<ClassesTab {...props({ classesResult: listed([openClass]), wrap })} />);

    await user.click(screen.getByRole('radio'));
    await user.click(screen.getByRole('button', { name: /Enroll/i }));

    expect(wrap).toHaveBeenCalled();
    expect(wrap.mock.calls[0]![0]).toBe('classes');
  });

  it('ignores a non-list payload so an enroll result cannot corrupt the picker', () => {
    // The enroll response is a Booking, not { classes: [...] }.
    render(
      <ClassesTab {...props({ classesResult: { ok: true, data: { id: 'b1' } } as ActionResult })} />,
    );
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('warns that the waitlist checkbox cannot help on a provider without one', () => {
    render(<ClassesTab {...props({ selectedProvider: 'acuity', providerInfo: { label: 'Acuity' } })} />);
    const label = screen.getByText(/Join the waitlist if full/i).closest('label')!;
    expect(within(label).getByText(/has no waitlist/i)).toBeTruthy();
  });

  it('every label is tied to a control and ids are unique', () => {
    const { container } = render(<ClassesTab {...props()} />);
    const orphans = Array.from(container.querySelectorAll('label'))
      .filter((l) => {
        if (l.htmlFor) return !container.querySelector(`[id="${l.htmlFor}"]`);
        return !l.querySelector('input, select, textarea');
      })
      .map((l) => l.textContent?.trim() ?? '(empty)');
    expect(orphans).toEqual([]);

    const ids = Array.from(container.querySelectorAll('[id]')).map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
