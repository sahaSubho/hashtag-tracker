import { describe, it, expect, vi, afterEach } from "vitest";
import { computeBackoffMs } from "../../src/domain/backoff.js";

describe("computeBackoffMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the un-jittered ceiling grows exponentially with attempt number", () => {
    const base = 1000;
    const max = 900000;
    vi.spyOn(Math, "random").mockReturnValue(0.999999); // near-max jitter, close to the ceiling
    expect(computeBackoffMs(1, base, max)).toBeCloseTo(1000, -2);
    expect(computeBackoffMs(2, base, max)).toBeCloseTo(2000, -2);
    expect(computeBackoffMs(3, base, max)).toBeCloseTo(4000, -2);
  });

  it("caps the ceiling at maxMs however large the attempt is", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(computeBackoffMs(20, 1000, 900000)).toBeCloseTo(900000, -2);
  });

  it("full jitter can return 0 (Math.random() = 0)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(computeBackoffMs(5, 1000, 900000)).toBe(0);
  });

  it("applies roughly half the ceiling at jitter = 0.5", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeBackoffMs(1, 1000, 900000)).toBe(500);
  });

  it("never returns a negative delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(computeBackoffMs(0, 1000, 900000)).toBeGreaterThanOrEqual(0);
  });
});
