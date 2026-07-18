/**
 * In-memory sliding-window rate limiter, keyed by client IP.
 *
 * This is COST CONTROL, not a security boundary: the proxy is useless without
 * the caller's own valid provider credentials, so an attacker gains nothing by
 * flooding it. The goal is only to stop one bored visitor from burning the
 * function quota. It's per-instance and resets on cold start — Vercel's
 * platform DDoS protection covers the distributed tail.
 *
 * The map is pruned and key-capped so the limiter itself can't become a
 * memory-exhaustion vector.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const MAX_KEYS = 5000;

const hits = new Map<string, number[]>();

export function allow(ip: string, nowMs: number = Date.now()): boolean {
  // Bound memory: if we're tracking too many keys, drop everything expired.
  if (hits.size > MAX_KEYS) {
    for (const [key, times] of hits) {
      const live = times.filter((t) => nowMs - t < WINDOW_MS);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }

  const recent = (hits.get(ip) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    hits.set(ip, recent); // persist the pruned window even when rejecting
    return false;
  }
  recent.push(nowMs);
  hits.set(ip, recent);
  return true;
}

/** Test hook — clears all tracked state. */
export function __resetRateLimit(): void {
  hits.clear();
}
