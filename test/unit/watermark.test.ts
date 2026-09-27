import { describe, it, expect } from "vitest";
import { decideStop } from "../../src/domain/watermark.js";

const ts = (s: string) => new Date(s);

describe("decideStop", () => {
  const wm = ts("2026-09-27T08:00:00Z");

  it("caught_up when every item is older than watermark minus skew", () => {
    expect(
      decideStop({
        edge: "recent",
        pageTimestamps: [ts("2026-09-27T07:40:00Z")],
        watermark: wm,
        skewMs: 600000,
        itemsSoFar: 25,
        maxItems: 500,
        hasNextCursor: true,
      })
    ).toBe("caught_up");
  });

  it("continues when the page straddles the watermark (out-of-order safe)", () => {
    expect(
      decideStop({
        edge: "recent",
        pageTimestamps: [ts("2026-09-27T07:40:00Z"), ts("2026-09-27T08:30:00Z")],
        watermark: wm,
        skewMs: 600000,
        itemsSoFar: 25,
        maxItems: 500,
        hasNextCursor: true,
      })
    ).toBe("continue");
  });

  it("cap_reached takes priority over more pages", () => {
    expect(
      decideStop({
        edge: "recent",
        pageTimestamps: [ts("2026-09-27T09:00:00Z")],
        watermark: wm,
        skewMs: 600000,
        itemsSoFar: 500,
        maxItems: 500,
        hasNextCursor: true,
      })
    ).toBe("cap_reached");
  });

  it("top edge never catches up, only cap or exhausted", () => {
    expect(
      decideStop({
        edge: "top",
        pageTimestamps: [ts("2020-01-01T00:00:00Z")],
        watermark: null,
        skewMs: 600000,
        itemsSoFar: 25,
        maxItems: 500,
        hasNextCursor: false,
      })
    ).toBe("exhausted");
  });

  it("continues on the first sync ever (no watermark) while pages remain", () => {
    expect(
      decideStop({
        edge: "recent",
        pageTimestamps: [ts("2026-09-27T07:40:00Z")],
        watermark: null,
        skewMs: 600000,
        itemsSoFar: 25,
        maxItems: 500,
        hasNextCursor: true,
      })
    ).toBe("continue");
  });

  it("exhausted when there is no watermark and no more pages", () => {
    expect(
      decideStop({
        edge: "recent",
        pageTimestamps: [ts("2026-09-27T07:40:00Z")],
        watermark: null,
        skewMs: 600000,
        itemsSoFar: 25,
        maxItems: 500,
        hasNextCursor: false,
      })
    ).toBe("exhausted");
  });

  it("does not stop at the first already-seen id on an out-of-order page (never true, but caught_up requires the MAX ts, not the first)", () => {
    // A page ordered [newer, older] must still be judged by its max timestamp.
    expect(
      decideStop({
        edge: "recent",
        pageTimestamps: [ts("2026-09-27T08:30:00Z"), ts("2026-09-27T07:00:00Z")],
        watermark: wm,
        skewMs: 600000,
        itemsSoFar: 25,
        maxItems: 500,
        hasNextCursor: true,
      })
    ).toBe("continue");
  });
});
