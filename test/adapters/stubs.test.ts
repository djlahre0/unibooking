import { describe, expect, it } from 'vitest';
import { mangomint } from '../../src/adapters/mangomint';

const RANGE = { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' };

for (const [name, factory] of [['mangomint', mangomint]] as const) {
  describe(`stub: ${name}`, () => {
    const client = factory({} as any);

    it('has all-false capabilities', () => {
      expect(Object.values(client.capabilities).every((v) => v === false)).toBe(true);
    });

    it('every method throws UNSUPPORTED', async () => {
      const calls = [
        () => client.createBooking({ title: 'x', range: RANGE }),
        () => client.getBooking('1'),
        () => client.updateBooking('1', {}),
        () => client.cancelBooking('1'),
        () => client.listBookings({ range: RANGE }),
        () => client.searchAvailability({ range: RANGE }),
      ];
      for (const call of calls) {
        const err = await call().then(() => null).catch((e: any) => e);
        expect(err?.code).toBe('UNSUPPORTED');
      }
    });
  });
}
