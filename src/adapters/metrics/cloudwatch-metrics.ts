import type { Metrics } from "../../ports/metrics.js";

const NAMESPACE = "HashtagTracker";

export interface CloudWatchMetricsOptions {
  /** Defaults to console.log. Injectable so tests can capture output without stdout. */
  write?: (line: string) => void;
}

/**
 * CloudWatch-backed Metrics implementation using Embedded Metric Format
 * (EMF) instead of PutMetricData API calls (spec §15.1). EMF is a
 * specially-shaped structured log line: the CloudWatch Logs agent parses
 * it out of the log stream and turns it into real CloudWatch metrics, at
 * zero extra API calls and zero extra cost beyond normal log ingestion —
 * appropriate for the high call volume this app's counters/histograms see
 * (every sync page, every asset download, every HTTP request), where
 * individual PutMetricData calls (max 20 datums per call, real API
 * latency and cost per call) would be the wrong tool.
 *
 * `inc`/`gauge`/`observe` all emit the same EMF shape — CloudWatch's model
 * has no separate "counter" or "histogram" type at ingestion; a counter is
 * just a metric value that happens to always be a small increment, and a
 * histogram is just a metric CloudWatch computes percentiles over across
 * many data points with the same name+dimensions.
 */
export class CloudWatchMetrics implements Metrics {
  private readonly write: (line: string) => void;

  constructor(opts: CloudWatchMetricsOptions = {}) {
    this.write = opts.write ?? ((line) => console.log(line));
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    this.emit(name, by, labels);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.emit(name, value, labels);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    this.emit(name, value, labels);
  }

  private emit(name: string, value: number, dimensions: Record<string, string>): void {
    const dimensionNames = Object.keys(dimensions);
    const line = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: NAMESPACE,
            Dimensions: dimensionNames.length > 0 ? [dimensionNames] : [[]],
            Metrics: [{ Name: name }],
          },
        ],
      },
      ...dimensions,
      [name]: value,
    };
    this.write(JSON.stringify(line));
  }
}
