import type { Clock } from "../../ports/clock.js";
import type { RateLimitStore, ConsumeOptions, ConsumeResult } from "../../ports/rate-limit-store.js";

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Fixed-window token counter, per key (spec §9). Simple and adequate for a
 * single process; the port is designed so this swaps for ElastiCache once
 * more than one instance runs (spec §15.6).
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly clock: Clock) {}

  async consume(opts: ConsumeOptions): Promise<ConsumeResult> {
    const now = this.clock.now().getTime();
    let bucket = this.buckets.get(opts.key);

    if (!bucket || now - bucket.windowStart >= opts.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(opts.key, bucket);
    }

    const cap = opts.limit + opts.burst;
    const windowEnd = bucket.windowStart + opts.windowMs;
    const cost = opts.cost ?? 1;

    if (bucket.count + cost > cap) {
      return { allowed: false, remaining: Math.max(0, cap - bucket.count), retryAfterMs: Math.max(0, windowEnd - now) };
    }

    bucket.count += cost;
    return {
      allowed: true,
      remaining: Math.max(0, cap - bucket.count),
      retryAfterMs: 0,
    };
  }
}
