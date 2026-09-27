import { describe, it, expect } from "vitest";
import { computeBurnRate } from "../../src/domain/slo.js";

describe("computeBurnRate (spec §14)", () => {
  it("burn rate of 1 means consuming the error budget exactly on schedule", () => {
    // 1% budget over 30 days; consuming 1% of that budget in 1% of the window is burn rate 1.
    const rate = computeBurnRate({ errorRatioInWindow: 0.0001, sloTarget: 0.99, windowFractionOfSloPeriod: 0.01 });
    expect(rate).toBeCloseTo(1, 5);
  });

  it("a fast burn (errors concentrated in a short window) has a high burn rate", () => {
    const rate = computeBurnRate({ errorRatioInWindow: 0.05, sloTarget: 0.99, windowFractionOfSloPeriod: 0.01 });
    expect(rate).toBeGreaterThan(14.4);
  });

  it("no errors in the window means burn rate 0", () => {
    const rate = computeBurnRate({ errorRatioInWindow: 0, sloTarget: 0.99, windowFractionOfSloPeriod: 0.01 });
    expect(rate).toBe(0);
  });
});
