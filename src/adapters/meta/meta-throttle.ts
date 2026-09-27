import type { Clock } from "../../ports/clock.js";

const HIGH_USAGE_PCT = 80;
const DEFAULT_PAUSE_MS = 15 * 60 * 1000;
const SPACING_MS_AT_HIGH_USAGE = 2000;

export interface MetaThrottleOptions {
  sleep?: (ms: number) => Promise<void> | void;
}

interface BusinessUsageEntry {
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number; // minutes, per Meta's docs
}

/**
 * Reads Meta's `X-Business-Use-Case-Usage` header after each call and
 * throttles the *next* call accordingly (spec §8): above 80% usage, calls
 * are spaced out; at 100%, every call pauses until the header's estimated
 * reset time (or a 15-minute default if the header doesn't give one).
 *
 * One throttle instance is shared by every call the process makes to a
 * given Instagram account, since the usage limit is per-account, not
 * per-endpoint.
 */
export class MetaThrottle {
  private lastUsagePct: number | null = null;
  private pausedUntil: number | null = null;
  private readonly sleep: (ms: number) => Promise<void> | void;

  constructor(
    private readonly clock: Clock,
    opts: MetaThrottleOptions = {}
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  currentUsagePct(): number | null {
    return this.lastUsagePct;
  }

  /** Parses the usage header from a response and updates internal state. Never throws. */
  recordUsage(headers: Record<string, string>): void {
    const raw = headers["x-business-use-case-usage"] ?? headers["x-app-usage"];
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Record<string, BusinessUsageEntry[]>;
      const entries = Object.values(parsed).flat();
      if (entries.length === 0) return;

      const pct = Math.max(
        ...entries.map((e) => Math.max(e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0))
      );
      this.lastUsagePct = pct;

      if (pct >= 100) {
        const minutesToReset = entries.find((e) => e.estimated_time_to_regain_access !== undefined)
          ?.estimated_time_to_regain_access;
        const pauseMs = minutesToReset !== undefined ? minutesToReset * 60 * 1000 : DEFAULT_PAUSE_MS;
        this.pausedUntil = this.clock.now().getTime() + pauseMs;
      } else {
        this.pausedUntil = null;
      }
    } catch {
      // A malformed header should never break the call; just skip it.
    }
  }

  /** Waits, if needed, before the next call is allowed to proceed. */
  async waitTurn(): Promise<void> {
    if (this.pausedUntil !== null) {
      const remaining = this.pausedUntil - this.clock.now().getTime();
      if (remaining > 0) {
        await this.sleep(remaining);
      }
      this.pausedUntil = null;
      return;
    }

    if (this.lastUsagePct !== null && this.lastUsagePct >= HIGH_USAGE_PCT) {
      await this.sleep(SPACING_MS_AT_HIGH_USAGE);
    }
  }
}
