import { Router } from "express";

/**
 * Liveness only. Readiness (/readyz, checking Postgres/relay/sweeper
 * heartbeats) is added in Phase 2 once the watchdog exists (spec §12.3).
 */
export function healthRouter(): Router {
  const router = Router();
  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  return router;
}
