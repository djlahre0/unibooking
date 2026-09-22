// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventForm from './EventForm';
import type { EventFormValues } from '../../lib/calendar/event-form';

const INITIAL: EventFormValues = {
  title: '',
  allDay: false,
  date: '2026-09-21',
  startTime: '10:00',
  endDate: '2026-09-21',
  endTime: '11:00',
  timezone: 'Asia/Kolkata',
  location: '',
  description: '',
};

afterEach(cleanup);

describe('EventForm', () => {
  it('blocks a submit without a title and says why', async () => {
    const onSubmit = vi.fn();
    render(
      <EventForm
        mode="new"
        initial={INITIAL}
        busy={false}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }));
    expect(screen.getByRole('alert').textContent).toBe('Title is required');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('swaps time inputs for dates when all-day is ticked', async () => {
    render(
      <EventForm
        mode="new"
        initial={INITIAL}
        busy={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText('Start time')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('All-day event'));
    expect(screen.queryByLabelText('Start time')).toBeNull();
    expect(screen.getByLabelText('End date')).toBeTruthy();
  });

  it('submits canonical instants in the chosen timezone', async () => {
    const onSubmit = vi.fn();
    render(
      <EventForm
        mode="new"
        initial={INITIAL}
        busy={false}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Title'), 'Team sync');
    await userEvent.type(screen.getByLabelText('Location'), 'Room 4');
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }));
    expect(onSubmit).toHaveBeenCalledWith({
      title: 'Team sync',
      start: '2026-09-21T10:00:00+05:30',
      end: '2026-09-21T11:00:00+05:30',
      timezone: 'Asia/Kolkata',
      allDay: false,
      location: 'Room 4',
    });
  });

  it('submits only what changed when editing', async () => {
    const onSubmit = vi.fn();
    render(
      <EventForm
        mode="edit"
        initial={{ ...INITIAL, title: 'Standup' }}
        busy={false}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const title = screen.getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Retro');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledWith({ title: 'Retro' });
  });
});
