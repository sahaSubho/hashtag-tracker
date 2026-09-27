import { sql, type Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { Queue } from "../ports/queue.js";
import type { Clock } from "../ports/clock.js";
import type { Metrics } from "../ports/metrics.js";
import { assetRepo } from "../db/repositories/asset-repo.js";
import { outboxRepo } from "../db/repositories/outbox-repo.js";
import { heartbeatRepo } from "../db/repositories/heartbeat-repo.js";

export interface SweeperDeps {
  db: Kysely<DB>;
  queue: Queue;
  clock: Clock;
  metrics: Metrics;
  /** Grace beyond an asset's lease_until before it is considered stuck. */
  staleLeaseGraceMs: number;
  /** How long a pending asset can sit with no unpublished outbox row before it's considered lost. */
  stalePendingGraceMs: number;
}

/**
 * Recovers from the two ways a download can go missing (spec §6.7,
 * failure mode D): a worker crashing mid-download (asset stuck in
 * `downloading` past its lease), and a lost queue message for an asset
 * that is `pending` but has no corresponding outbox row. Both cases are
 * repaired the same way: reset the asset to `pending` and enqueue a fresh
 * DOWNLOAD_ASSET outbox row.
 */
export async function runSweeperOnce(deps: SweeperDeps): Promise<number> {
  const { db, clock, metrics, staleLeaseGraceMs, stalePendingGraceMs } = deps;
  let requeued = 0;

  await heartbeatRepo.checkIn(db, "sweeper", clock.now());

  const leaseCutoff = new Date(clock.now().getTime() - staleLeaseGraceMs);
  const expiredLeases = await db
    .transaction()
    .execute((tx) => assetRepo.findExpiredLeases(tx, leaseCutoff));

  for (const asset of expiredLeases) {
    await db.transaction().execute(async (tx) => {
      await assetRepo.markStatus(tx, asset.id, "pending");
      await outboxRepo.enqueue(tx, "DOWNLOAD_ASSET", { assetId: asset.id }, clock.now());
    });
    requeued++;
  }

  const pendingCutoff = new Date(clock.now().getTime() - stalePendingGraceMs);
  const stalePending = await db
    .transaction()
    .execute((tx) => assetRepo.findStalePending(tx, pendingCutoff));

  for (const asset of stalePending) {
    const hasUnpublished = await db
      .selectFrom("outbox")
      .select("id")
      .where("kind", "=", "DOWNLOAD_ASSET")
      .where("published_at", "is", null)
      .where(sql<boolean>`payload ->> 'assetId' = ${String(asset.id)}`)
      .executeTakeFirst();

    if (!hasUnpublished) {
      await db
        .transaction()
        .execute((tx) => outboxRepo.enqueue(tx, "DOWNLOAD_ASSET", { assetId: asset.id }, clock.now()));
      requeued++;
    }
  }

  metrics.inc("sweeper.requeued", {}, requeued);
  return requeued;
}
