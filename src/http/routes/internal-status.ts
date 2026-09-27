import { Router, type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";
import type { BlobStorage } from "../../ports/blob-storage.js";
import { deleteMediaByIgId } from "../../services/retention.js";

export interface InternalStatusRouteDeps {
  db: Kysely<DB>;
  storage: BlobStorage;
  /**
   * Bearer token required for every /internal/* route. This is a stopgap:
   * spec §11/§12.3 calls for the `admin` API-key scope instead, which needs
   * the api_keys table and auth middleware (plan P3-01). Until then, a
   * single shared token read from config plays the same
   * "don't expose internals publicly" role.
   */
  adminToken: string;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function requireAdminToken(adminToken: string): RequestHandler {
  return (req, res, next) => {
    const auth = req.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

    if (!token || !safeEqual(token, adminToken)) {
      res.status(401).json({ error: { code: "unauthorized", message: "invalid admin token" } });
      return;
    }
    next();
  };
}

export function internalStatusRouter(deps: InternalStatusRouteDeps): Router {
  const router = Router();
  router.use(requireAdminToken(deps.adminToken));

  router.get("/internal/status", async (_req, res) => {
    const lastRuns = await deps.db
      .selectFrom("sync_runs")
      .selectAll()
      .orderBy("started_at", "desc")
      .limit(10)
      .execute();

    const outboxBacklogRow = await deps.db
      .selectFrom("outbox")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("published_at", "is", null)
      .executeTakeFirst();

    const assetCounts = await deps.db
      .selectFrom("media_assets")
      .select(["status", (eb) => eb.fn.countAll().as("n")])
      .groupBy("status")
      .execute();

    const firingAlerts = await deps.db
      .selectFrom("alerts")
      .selectAll()
      .where("state", "=", "firing")
      .execute();

    res.status(200).json({
      lastRuns: lastRuns.map((r) => ({
        id: r.id,
        edge: r.edge,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        itemsFetched: r.items_fetched,
        gapStatus: r.gap_status,
      })),
      outboxBacklog: Number(outboxBacklogRow?.n ?? 0),
      assetCounts: Object.fromEntries(assetCounts.map((a) => [a.status, Number(a.n)])),
      firingAlerts: firingAlerts.map((a) => a.alert_key),
    });
  });

  /** Deletes one post by its Instagram media ID (spec §6.8), for right-to-erasure or takedown requests. */
  router.delete("/internal/media/:igMediaId", async (req, res) => {
    const deleted = await deleteMediaByIgId(deps.db, deps.storage, req.params.igMediaId);
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "no such media" } });
      return;
    }
    res.status(200).json({ deleted: true });
  });

  return router;
}
