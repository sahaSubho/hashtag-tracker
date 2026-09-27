import type { Metrics } from "../../ports/metrics.js";

/**
 * A Metrics implementation that does nothing. Used until Phase 2 wires up
 * the real prom-client adapter and the /metrics endpoint (spec §12.2,
 * plan P2-03) — every call site already goes through the Metrics
 * interface, so swapping this out later touches no domain code.
 */
export class NoopMetrics implements Metrics {
  inc(): void {}
  gauge(): void {}
  observe(): void {}
}
