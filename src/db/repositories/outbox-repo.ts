import type { Transaction } from "kysely";
import type { DB } from "../schema.js";

export interface OutboxRow {
  id: number;
  kind: string;
  payload: unknown;
}

export const outboxRepo = {
  async enqueue(
    tx: Transaction<DB>,
    kind: string,
    payload: unknown,
    availableAt: Date
  ): Promise<void> {
    await tx
      .insertInto("outbox")
      .values({
        kind,
        payload: JSON.stringify(payload),
        available_at: availableAt,
      })
      .execute();
  },

  /**
   * Claims up to `limit` due, unpublished rows using FOR UPDATE SKIP LOCKED
   * so multiple relay processes never double-claim the same row.
   */
  async claimBatch(tx: Transaction<DB>, limit: number, now: Date): Promise<OutboxRow[]> {
    const rows = await tx
      .selectFrom("outbox")
      .selectAll()
      .where("published_at", "is", null)
      .where("available_at", "<=", now)
      .orderBy("id", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload }));
  },

  async markPublished(tx: Transaction<DB>, id: number): Promise<void> {
    await tx
      .updateTable("outbox")
      .set({ published_at: new Date(), attempts: (eb) => eb("attempts", "+", 1) })
      .where("id", "=", id)
      .execute();
  },

  async deletePublishedOlderThan(tx: Transaction<DB>, cutoff: Date): Promise<number> {
    const result = await tx
      .deleteFrom("outbox")
      .where("published_at", "is not", null)
      .where("published_at", "<", cutoff)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  },
};
