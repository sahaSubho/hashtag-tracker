import { describe, it, expect } from "vitest";
import { computeFreshnessSlo, computeCompletenessSlo } from "../../src/domain/slo.js";

interface FakeRun {
  edge: "top" | "recent";
  status: "SUCCESS" | "TRUNCATED" | "FAILED" | "RUNNING";
  gap_status: "none" | "open" | "closed" | "unrecoverable";
  started_at: Date;
}

const run = (over: Partial<FakeRun>): FakeRun => ({
  edge: "recent",
  status: "SUCCESS",
  gap_status: "none",
  started_at: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

describe("computeFreshnessSlo (spec §14 SLO 1)", () => {
  it("100% when every 3h window has a SUCCESS or TRUNCATED-closed-gap run", () => {
    const windowStart = new Date("2026-09-01T00:00:00Z");
    const runs = [
      run({ started_at: new Date("2026-09-01T00:30:00Z") }),
      run({ started_at: new Date("2026-09-01T03:30:00Z") }),
    ];
    const result = computeFreshnessSlo(runs, windowStart, new Date("2026-09-01T06:00:00Z"), 3 * 3600000);
    expect(result.ratio).toBe(1);
  });

  it("counts a window with no qualifying run as a miss", () => {
    const windowStart = new Date("2026-09-01T00:00:00Z");
    const runs = [run({ started_at: new Date("2026-09-01T00:30:00Z") })]; // only the first window covered
    const result = computeFreshnessSlo(runs, windowStart, new Date("2026-09-01T06:00:00Z"), 3 * 3600000);
    expect(result.ratio).toBe(0.5);
    expect(result.totalWindows).toBe(2);
    expect(result.goodWindows).toBe(1);
  });

  it("a TRUNCATED run with an open (not yet closed) gap does not count as good", () => {
    const windowStart = new Date("2026-09-01T00:00:00Z");
    const runs = [run({ status: "TRUNCATED", gap_status: "open", started_at: new Date("2026-09-01T00:30:00Z") })];
    const result = computeFreshnessSlo(runs, windowStart, new Date("2026-09-01T03:00:00Z"), 3 * 3600000);
    expect(result.ratio).toBe(0);
  });

  it("a TRUNCATED run whose gap later closed counts as good", () => {
    const windowStart = new Date("2026-09-01T00:00:00Z");
    const runs = [run({ status: "TRUNCATED", gap_status: "closed", started_at: new Date("2026-09-01T00:30:00Z") })];
    const result = computeFreshnessSlo(runs, windowStart, new Date("2026-09-01T03:00:00Z"), 3 * 3600000);
    expect(result.ratio).toBe(1);
  });

  it("a FAILED run does not count as good", () => {
    const windowStart = new Date("2026-09-01T00:00:00Z");
    const runs = [run({ status: "FAILED", started_at: new Date("2026-09-01T00:30:00Z") })];
    const result = computeFreshnessSlo(runs, windowStart, new Date("2026-09-01T03:00:00Z"), 3 * 3600000);
    expect(result.ratio).toBe(0);
  });
});

describe("computeCompletenessSlo (spec §14 SLO 2)", () => {
  it("100% when no window ends in an unrecoverable gap", () => {
    const runs = [run({ gap_status: "none" }), run({ gap_status: "closed" })];
    const result = computeCompletenessSlo(runs);
    expect(result.ratio).toBe(1);
  });

  it("counts an unrecoverable gap as bad", () => {
    const runs = [run({ gap_status: "none" }), run({ gap_status: "unrecoverable" })];
    const result = computeCompletenessSlo(runs);
    expect(result.ratio).toBe(0.5);
  });
});
