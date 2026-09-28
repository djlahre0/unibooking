import type { ErrorCode } from 'unibooking';

/** One-shot failure injection, so the retry utilities and error states can be
 *  exercised without a real outage. Deliberately in memory: persisting it would
 *  leave the demo mysteriously broken after a reload. */
let armed: ErrorCode | null = null;

export function armFailure(code: ErrorCode | null): void {
  armed = code;
}

/** Returns the armed code and disarms, so exactly one call fails. */
export function takeArmedFailure(): ErrorCode | null {
  const code = armed;
  armed = null;
  return code;
}
