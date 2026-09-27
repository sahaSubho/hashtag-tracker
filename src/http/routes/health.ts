import { Router } from "express";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";
import type { Clock } from "../../ports/clock.js";
import { heartbeatRepo } from "../../db/repositories/heartbeat-repo.js";

export interface HealthRouteDeps {
  db: Kysely<DB>;
  clock: Clock;
}

const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const REQUIRED_COMPONENTS = ["relay", "sweeper"];

export function healthRouter(deps: HealthRouteDeps): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  /**
   * Ready when Postgres responds and the relay and sweeper have both
   * checked in within the last 2 minutes (spec §12.3). A missing or stale
   * heartbeat means that background component has stopped running, even
   * though the API process itself is alive.
   */
  router.get("/readyz", async (_req, res) => {
    try {
      const now = deps.clock.now().getTime();
      const checks = await Promise.all(
        REQUIRED_COMPONENTS.map(async (component) => {
          const lastSeen = await heartbeatRepo.lastSeen(deps.db, component);
          return { component, ok: lastSeen !== null && now - lastSeen.getTime() <= HEARTBEAT_STALE_MS };
        })
      );

      const allOk = checks.every((c) => c.ok);
      res.status(allOk ? 200 : 503).json({ status: allOk ? "ready" : "not_ready", checks });
    } catch {
      res.status(503).json({ status: "not_ready", error: "database unreachable" });
    }
  });

  return router;
}
