import { Registry, Counter, Gauge, Histogram } from "prom-client";
import type { Metrics } from "../../ports/metrics.js";

/**
 * Real Metrics implementation backed by prom-client (spec §12.2). Metrics
 * are named exactly as callers pass them (e.g. "sync.page_fetched"), with
 * dots replaced by underscores to satisfy Prometheus naming rules.
 *
 * prom-client requires a metric's label names to be declared up front, but
 * our Metrics port takes an arbitrary label object per call. So each named
 * metric is created lazily on its first call, with its label names fixed
 * to whatever keys that first call used — every later call for the same
 * name must use the same label keys (which every call site in this
 * codebase does, since label sets are hardcoded per metric name).
 */
export class PromMetrics implements Metrics {
  private readonly registry = new Registry();
  private counters = new Map<string, Counter<string>>();
  private gauges = new Map<string, Gauge<string>>();
  private histograms = new Map<string, Histogram<string>>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const metricName = normalize(name);
    let counter = this.counters.get(metricName);
    if (!counter) {
      counter = new Counter({
        name: metricName,
        help: metricName,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.counters.set(metricName, counter);
    }
    counter.inc(labels, by);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const metricName = normalize(name);
    let gauge = this.gauges.get(metricName);
    if (!gauge) {
      gauge = new Gauge({
        name: metricName,
        help: metricName,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.gauges.set(metricName, gauge);
    }
    gauge.set(labels, value);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const metricName = normalize(name);
    let histogram = this.histograms.get(metricName);
    if (!histogram) {
      histogram = new Histogram({
        name: metricName,
        help: metricName,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.histograms.set(metricName, histogram);
    }
    histogram.observe(labels, value);
  }

  /** Renders all metrics in Prometheus text exposition format, for the /metrics endpoint. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}

function normalize(name: string): string {
  return name.replace(/[.-]/g, "_");
}
