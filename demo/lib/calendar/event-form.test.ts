import { describe, expect, it } from 'vitest';
import type { Booking } from 'unibooking';
import {
  changedInput,
  defaultValues,
  isValidZone,
  toEventInput,
  validate,
  valuesFromBooking,
  type EventFormValues,
} from './event-form';

const BASE: EventFormValues = {
  title: 'Standup',
  allDay: false,
  date: '2026-09-21',
  startTime: '10:00',
  endDate: '2026-09-21',
  endTime: '10:30',
  timezone: 'Asia/Kolkata',
  location: '',
  description: '',
};

describe('defaults and zones', () => {
  it('starts at the next whole hour for one hour', () => {
    const v = defaultValues('Asia/Kolkata', new Date('2026-09-21T04:10:00Z')); // 09:40 IST
    expect(v).toMatchObject({
      date: '2026-09-21',
      startTime: '10:00',
      endDate: '2026-09-21',
      endTime: '11:00',
    });
  });

  it('rolls past midnight into the next day', () => {
    const v = defaultValues('UTC', new Date('2026-09-21T23:30:00Z'));
    expect(v).toMatchObject({ date: '2026-09-22', startTime: '00:00', endTime: '01:00' });
  });

  it('recognises real zones only', () => {
    expect(isValidZone('Europe/Paris')).toBe(true);
    expect(isValidZone('Europe/Nowhere')).toBe(false);
    expect(isValidZone('')).toBe(false);
  });
});

describe('validate', () => {
  it('requires a title', () => {
    expect(validate({ ...BASE, title: '   ' })).toBe('Title is required');
  });
  it('requires end after start', () => {
    expect(validate({ ...BASE, endTime: '10:00' })).toBe('End must be after start');
  });
  it('rejects an unknown timezone', () => {
    expect(validate({ ...BASE, timezone: 'Mars/Base' })).toBe('Unknown timezone');
  });
  it('rejects an all-day end date before the start date', () => {
    expect(validate({ ...BASE, allDay: true, endDate: '2026-09-20' })).toBe(
      'End date must be on or after the start date',
    );
  });
  it('accepts a valid event', () => {
    expect(validate(BASE)).toBeNull();
  });
});

describe('conversion', () => {
  it('turns a timed form into zone-anchored instants', () => {
    expect(toEventInput({ ...BASE, location: 'Room 4' })).toEqual({
      title: 'Standup',
      start: '2026-09-21T10:00:00+05:30',
      end: '2026-09-21T10:30:00+05:30',
      timezone: 'Asia/Kolkata',
      allDay: false,
      location: 'Room 4',
    });
  });

  it('sends an inclusive all-day end date as an exclusive boundary', () => {
    expect(toEventInput({ ...BASE, allDay: true, endDate: '2026-09-22' })).toMatchObject({
      start: '2026-09-21T00:00:00+05:30',
      end: '2026-09-23T00:00:00+05:30',
      allDay: true,
    });
  });

  it('reads an all-day booking back as inclusive dates', () => {
    const b: Booking = {
      id: 'x',
      provider: 'google',
      title: 'Offsite',
      range: { start: '2026-09-21T00:00:00Z', end: '2026-09-23T00:00:00Z' },
      status: 'confirmed',
      allDay: true,
      raw: {},
    };
    expect(valuesFromBooking(b, 'UTC')).toMatchObject({
      allDay: true,
      date: '2026-09-21',
      endDate: '2026-09-22',
    });
  });

  it('reads a timed booking in its own zone when it has one', () => {
    const b: Booking = {
      id: 'x',
      provider: 'google',
      title: 'Call',
      range: {
        start: '2026-09-21T04:30:00Z',
        end: '2026-09-21T05:00:00Z',
        timezone: 'Asia/Kolkata',
      },
      status: 'confirmed',
      location: 'Zoom',
      raw: {},
    };
    expect(valuesFromBooking(b, 'UTC')).toMatchObject({
      date: '2026-09-21',
      startTime: '10:00',
      endTime: '10:30',
      timezone: 'Asia/Kolkata',
      location: 'Zoom',
    });
  });
});

describe('changedInput', () => {
  it('sends only a changed title', () => {
    expect(changedInput(BASE, { ...BASE, title: 'Retro' })).toEqual({ title: 'Retro' });
  });
  it('sends the whole timing group when any timing field changes', () => {
    expect(changedInput(BASE, { ...BASE, endTime: '11:00' })).toEqual({
      start: '2026-09-21T10:00:00+05:30',
      end: '2026-09-21T11:00:00+05:30',
      timezone: 'Asia/Kolkata',
      allDay: false,
    });
  });
  it('sends a cleared field as an empty string', () => {
    expect(changedInput({ ...BASE, location: 'Room 4' }, BASE)).toEqual({ location: '' });
  });
  it('sends nothing when nothing changed', () => {
    expect(changedInput(BASE, { ...BASE })).toEqual({});
  });
});
