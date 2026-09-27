import { Router, type RequestHandler } from "express";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";
import type { BlobStorage } from "../../ports/blob-storage.js";
import type { Clock } from "../../ports/clock.js";
import { deleteMediaByIgId } from "../../services/retention.js";
import { authenticateApiKey } from "../api-key-auth.js";

export interface InternalStatusRouteDeps {
  db: Kysely<DB>;
  storage: BlobStorage;
  clock: Clock;
}

const ADMIN_SCOPE = "admin";

function requireAdminApiKey(db: Kysely<DB>, clock: Clock): RequestHandler {
  return async (req, res, next) => {
    const auth = req.get("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

    if (!key) {
      res.status(401).json({ error: { code: "unauthorized", message: "missing API key" } });
      return;
    }

    const result = await authenticateApiKey(db, clock, key, ADMIN_SCOPE);
    if (!result.ok) {
      res.status(result.reason === "missing_scope" ? 403 : 401).json({
        error: { code: "unauthorized", message: "invalid or insufficiently-scoped API key" },
      });
      return;
    }

    next();
  };
}

/**
 * Internal operator endpoints (spec §11, §12.3): status/health snapshot and
 * one-off media deletion. Gated by an `admin`-scoped API key (plan P3-01) —
 * these were originally behind a single shared bearer token from config;
 * that stopgap is now replaced by real, individually-issued and revocable
 * API keys.
 */
export function internalStatusRouter(deps: InternalStatusRouteDeps): Router {
  const router = Router();
  router.use(requireAdminApiKey(deps.db, deps.clock));

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
