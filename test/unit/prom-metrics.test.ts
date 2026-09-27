import { describe, it, expect } from "vitest";
import { PromMetrics } from "../../src/adapters/metrics/prom-metrics.js";

describe("PromMetrics", () => {
  it("inc() increments a counter by 1 by default", async () => {
    const m = new PromMetrics();
    m.inc("test_counter_total");
    m.inc("test_counter_total");
    const text = await m.render();
    expect(text).toMatch(/test_counter_total 2/);
  });

  it("inc() accepts a custom amount", async () => {
    const m = new PromMetrics();
    m.inc("test_counter2_total", {}, 5);
    const text = await m.render();
    expect(text).toMatch(/test_counter2_total 5/);
  });

  it("inc() supports labels", async () => {
    const m = new PromMetrics();
    m.inc("test_labeled_total", { edge: "recent" });
    m.inc("test_labeled_total", { edge: "top" });
    const text = await m.render();
    expect(text).toMatch(/test_labeled_total\{edge="recent"\} 1/);
    expect(text).toMatch(/test_labeled_total\{edge="top"\} 1/);
  });

  it("gauge() sets a value", async () => {
    const m = new PromMetrics();
    m.gauge("test_gauge", 42);
    const text = await m.render();
    expect(text).toMatch(/test_gauge 42/);
  });

  it("observe() records into a histogram", async () => {
    const m = new PromMetrics();
    m.observe("test_histogram_seconds", 0.5);
    const text = await m.render();
    expect(text).toMatch(/test_histogram_seconds_sum/);
  });

  it("reuses the same metric across calls with different label sets", async () => {
    const m = new PromMetrics();
    m.inc("reused_total", { a: "1" });
    m.inc("reused_total", { a: "2" });
    m.inc("reused_total", { a: "1" });
    const text = await m.render();
    expect(text).toMatch(/reused_total\{a="1"\} 2/);
    expect(text).toMatch(/reused_total\{a="2"\} 1/);
  });
});
