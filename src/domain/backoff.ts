/**
 * Exponential backoff with full jitter (spec §8): delay = random(0, min(max,
 * base * 2^(attempt-1))). Attempt 1 is the first retry. Full jitter avoids
 * synchronized retry storms when many jobs fail at once.
 */
export function computeBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(attempt - 1, 0);
  const capped = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.floor(Math.random() * capped);
}
