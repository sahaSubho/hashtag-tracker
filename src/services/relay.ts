import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { Queue } from "../ports/queue.js";
import type { Clock } from "../ports/clock.js";
import type { Metrics } from "../ports/metrics.js";
import { outboxRepo } from "../db/repositories/outbox-repo.js";

export interface RelayDeps {
  db: Kysely<DB>;
  queue: Queue;
  clock: Clock;
  metrics: Metrics;
  batchSize: number;
}

/**
 * The transactional-outbox relay (spec §6.3). Claims due, unpublished rows
 * with FOR UPDATE SKIP LOCKED, publishes each to the Queue, then marks it
 * published — in that order, so a crash between publish and the mark means
 * the row is republished on the next run rather than lost. Every job
 * handler must therefore be safe to run twice (delivery is at-least-once).
 */
export async function runRelayOnce(deps: RelayDeps): Promise<number> {
  const { db, queue, clock, metrics, batchSize } = deps;

  const rows = await db
    .transaction()
    .execute((tx) => outboxRepo.claimBatch(tx, batchSize, clock.now()));

  for (const row of rows) {
    await queue.enqueue(row.kind, row.payload);
    await db.transaction().execute((tx) => outboxRepo.markPublished(tx, row.id));
    metrics.inc("outbox.published", { kind: row.kind });
  }

  return rows.length;
}
