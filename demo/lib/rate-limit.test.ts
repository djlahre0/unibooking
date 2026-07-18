import { describe, it, expect, beforeEach } from 'vitest';
import { allow, __resetRateLimit } from './rate-limit';

describe('rate limiter', () => {
  beforeEach(() => __resetRateLimit());

  it('allows requests up to the limit', () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) {
      expect(allow('1.2.3.4', t)).toBe(true);
    }
  });

  it('rejects the request that exceeds the limit', () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) allow('1.2.3.4', t);
    expect(allow('1.2.3.4', t)).toBe(false);
  });

  it('tracks IPs independently', () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) allow('1.1.1.1', t);
    expect(allow('1.1.1.1', t)).toBe(false);
    expect(allow('2.2.2.2', t)).toBe(true);
  });

  it('lets requests through again after the window slides', () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) allow('9.9.9.9', t);
    expect(allow('9.9.9.9', t)).toBe(false);
    // 61s later, the original hits have expired.
    expect(allow('9.9.9.9', t + 61_000)).toBe(true);
  });
});
