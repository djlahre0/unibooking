/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import BookingsTab from './BookingsTab';
import AvailabilityTab from './AvailabilityTab';
import CustomersTab from './CustomersTab';
import CatalogTab from './CatalogTab';
import WebhooksTab from './WebhooksTab';

/**
 * Every visible form label must actually be associated with its control:
 * either by wrapping it, or by `htmlFor` pointing at the control's `id`. A
 * bare `<label>Start</label>` next to an unlabelled `<input>` looks correct on
 * screen and is invisible to a screen reader, which announces the field as
 * unlabelled; clicking the text also fails to focus the input. Spec §4.5
 * requires "labels tied to every input".
 */
function orphanLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('label'))
    .filter((l) => {
      // Attribute selector rather than `#id`: jsdom here has no CSS.escape,
      // and an id selector would choke on anything non-trivial.
      if (l.htmlFor) return !container.querySelector(`[id="${l.htmlFor}"]`);
      return !l.querySelector('input, select, textarea');
    })
    .map((l) => l.textContent?.trim() ?? '(empty)');
}

/** An `id` must be unique, or `htmlFor` resolves to the wrong control. */
function duplicateIds(container: HTMLElement): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const el of Array.from(container.querySelectorAll('[id]'))) {
    const id = el.id;
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  return dupes;
}

const shared = {
  selectedProvider: 'sample',
  providerInfo: { label: 'Sample Data' } as never,
  conn: { creds: {} },
  wrap: (async () => {}) as never,
  busy: () => false,
};

const range = {
  start: '2026-09-14T00:00:00Z',
  end: '2026-10-12T00:00:00Z',
  dayStart: '2026-09-22T00:00:00Z',
  dayEnd: '2026-09-23T00:00:00Z',
  slotStart: '2026-09-22T10:00:00Z',
  slotEnd: '2026-09-22T10:45:00Z',
};

afterEach(cleanup);

describe('form labels are associated with their controls', () => {
  it('Bookings', () => {
    const { container } = render(
      <BookingsTab
        {...shared}
        defaultRange={range}
        bookingResult={null}
        setBookingResult={() => {}}
      />,
    );
    expect(orphanLabels(container)).toEqual([]);
    expect(duplicateIds(container)).toEqual([]);
  });

  it('Availability', () => {
    const { container } = render(
      <AvailabilityTab
        {...shared}
        defaultRange={range}
        availResult={null}
        setAvailResult={() => {}}
      />,
    );
    expect(orphanLabels(container)).toEqual([]);
    expect(duplicateIds(container)).toEqual([]);
  });

  it('Customers', () => {
    const { container } = render(
      <CustomersTab {...shared} customerResult={null} setCustomerResult={() => {}} />,
    );
    expect(orphanLabels(container)).toEqual([]);
    expect(duplicateIds(container)).toEqual([]);
  });

  it('Catalog', () => {
    const { container } = render(
      <CatalogTab {...shared} catalogResult={null} setCatalogResult={() => {}} />,
    );
    expect(orphanLabels(container)).toEqual([]);
    expect(duplicateIds(container)).toEqual([]);
  });

  it('Webhooks', () => {
    const { container } = render(
      <WebhooksTab
        webhookResult={null}
        setWebhookResult={() => {}}
        wrap={shared.wrap}
        busy={shared.busy}
      />,
    );
    expect(orphanLabels(container)).toEqual([]);
    expect(duplicateIds(container)).toEqual([]);
  });
});
