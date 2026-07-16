import { describe, expect, it } from 'vitest';
import { graphToInstant, nextLinkFrom } from '../src/graph';

describe('graphToInstant', () => {
  it('appends Z to a naive UTC dateTime', () => {
    expect(graphToInstant({ dateTime: '2026-07-20T22:00:00.0000000', timeZone: 'UTC' })).toBe(
      '2026-07-20T22:00:00Z',
    );
  });

  it('resolves a naive dateTime carried in a non-UTC (Windows) timeZone', () => {
    // Pacific Standard Time is PDT (UTC-7) in July, so 15:00 local -> 22:00Z.
    // Previously the timeZone was dropped and this was mis-read as 15:00Z.
    expect(
      graphToInstant({ dateTime: '2026-07-20T15:00:00.0000000', timeZone: 'Pacific Standard Time' }),
    ).toBe('2026-07-20T22:00:00Z');
  });

  it('honors an explicit offset when one is present', () => {
    expect(
      graphToInstant({ dateTime: '2026-07-20T15:00:00-07:00', timeZone: 'Pacific Standard Time' }),
    ).toBe('2026-07-20T22:00:00Z');
  });
});

describe('nextLinkFrom', () => {
  it('returns the full @odata.nextLink (so $skiptoken AND $skip both work)', () => {
    expect(
      nextLinkFrom({ '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=50' }),
    ).toBe('https://graph.microsoft.com/v1.0/me/calendarView?$skip=50');
    expect(nextLinkFrom({ value: [] })).toBeUndefined();
  });
});
