import { describe, it, expect } from "vitest";
import { CloudWatchMetrics } from "../../src/adapters/metrics/cloudwatch-metrics.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureOne(fn: (m: CloudWatchMetrics) => void): any {
  const lines: string[] = [];
  const metrics = new CloudWatchMetrics({ write: (line) => lines.push(line) });
  fn(metrics);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
}

describe("CloudWatchMetrics — Embedded Metric Format", () => {
  it("inc() emits a valid EMF line with the metric namespace, name, and value", () => {
    const parsed = captureOne((m) => m.inc("sync.page_fetched", { edge: "recent" }));
    expect(parsed._aws.CloudWatchMetrics[0].Namespace).toBe("HashtagTracker");
    expect(parsed._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: "sync.page_fetched" }]);
    expect(parsed["sync.page_fetched"]).toBe(1);
    expect(parsed.edge).toBe("recent");
  });

  it("inc() respects a custom increment amount", () => {
    const parsed = captureOne((m) => m.inc("items", {}, 5));
    expect(parsed.items).toBe(5);
  });

  it("dimensions declared match the labels object's keys, in EMF's [[...]] shape", () => {
    const parsed = captureOne((m) => m.gauge("outbox_pending", 42, { hashtag: "matcha" }));
    expect(parsed._aws.CloudWatchMetrics[0].Dimensions).toEqual([["hashtag"]]);
    expect(parsed.hashtag).toBe("matcha");
    expect(parsed.outbox_pending).toBe(42);
  });

  it("a metric with no labels declares an empty dimension set, not a missing one", () => {
    const parsed = captureOne((m) => m.observe("http_request_duration_seconds", 0.05));
    expect(parsed._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });

  it("includes a millisecond Unix timestamp", () => {
    const before = Date.now();
    const parsed = captureOne((m) => m.inc("x"));
    const after = Date.now();
    expect(parsed._aws.Timestamp).toBeGreaterThanOrEqual(before);
    expect(parsed._aws.Timestamp).toBeLessThanOrEqual(after);
  });
});
