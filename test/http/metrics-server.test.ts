import { describe, it, expect, afterEach } from "vitest";
import { PromMetrics } from "../../src/adapters/metrics/prom-metrics.js";
import { createMetricsServer } from "../../src/http/metrics-server.js";
import type { Server } from "node:http";

describe("metrics server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  });

  it("serves prom-client's exposition format on /metrics", async () => {
    const metrics = new PromMetrics();
    metrics.inc("smoke_total");
    server = createMetricsServer(metrics);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toMatch(/smoke_total 1/);
  });

  it("returns 404 for any other path", async () => {
    const metrics = new PromMetrics();
    server = createMetricsServer(metrics);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
