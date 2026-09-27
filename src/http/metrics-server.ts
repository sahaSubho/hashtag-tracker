import http, { type Server } from "node:http";
import type { PromMetrics } from "../adapters/metrics/prom-metrics.js";

/**
 * A minimal, separate HTTP server for /metrics (spec §12.3, §15.1: run on
 * an internal-only port/security-group, never the public API port). A
 * plain node:http server, not Express, since it serves exactly one path.
 */
export function createMetricsServer(metrics: PromMetrics): Server {
  return http.createServer((req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      metrics
        .render()
        .then((body) => {
          res.writeHead(200, { "Content-Type": metrics.contentType() });
          res.end(body);
        })
        .catch((err) => {
          res.writeHead(500);
          res.end(String(err));
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
