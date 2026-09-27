import { describe, it, expect } from "vitest";
import { FakeClock } from "../helpers/fakes.js";
import { MetaThrottle } from "../../src/adapters/meta/meta-throttle.js";

const usageHeader = (pct: number) =>
  JSON.stringify({ "123": [{ type: "instagram", call_count: pct, total_cputime: pct, total_time: pct }] });

describe("MetaThrottle", () => {
  it("does not delay when usage is low", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const throttle = new MetaThrottle(clock);
    throttle.recordUsage({ "x-business-use-case-usage": usageHeader(10) });
    const start = clock.now().getTime();
    await throttle.waitTurn();
    expect(clock.now().getTime()).toBe(start); // no sleep was awaited
  });

  it("reports usage percent from the last recorded header", () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const throttle = new MetaThrottle(clock);
    throttle.recordUsage({ "x-business-use-case-usage": usageHeader(85) });
    expect(throttle.currentUsagePct()).toBe(85);
  });

  it("returns null usage when no header has been recorded yet", () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const throttle = new MetaThrottle(clock);
    expect(throttle.currentUsagePct()).toBeNull();
  });

  it("ignores a malformed usage header instead of throwing", () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const throttle = new MetaThrottle(clock);
    expect(() => throttle.recordUsage({ "x-business-use-case-usage": "not json" })).not.toThrow();
    expect(throttle.currentUsagePct()).toBeNull();
  });

  it("pauses all calls until the reset time once usage hits 100%", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const throttle = new MetaThrottle(clock, { sleep: (ms) => clock.advance(ms) });
    const resetEpochSeconds = Math.floor(clock.now().getTime() / 1000) + 900; // 15 min from now
    throttle.recordUsage({
      "x-business-use-case-usage": JSON.stringify({
        "123": [{ call_count: 100, estimated_time_to_regain_access: 15 }],
      }),
    });
    void resetEpochSeconds;

    await throttle.waitTurn();
    // pause used the 15-minute estimate from the header
    expect(clock.now().getTime()).toBe(new Date("2026-01-01T00:15:00Z").getTime());
  });
});
