import type { Kysely, Transaction } from "kysely";
import type { DB, SyncEdge, SyncStatus, GapStatus } from "../schema.js";

export interface CreateSyncRunInput {
  hashtagId: number;
  edge: SyncEdge;
  watermarkBefore: Date | null;
  parentRunId?: string;
}

export interface FinishSyncRunInput {
  status: SyncStatus;
  newestSeenTs?: Date | null;
  oldestSeenTs?: Date | null;
  resumeCursor?: string | null;
  gapStatus?: GapStatus;
  errorCode?: string;
  errorMessage?: string;
}

export const syncRunRepo = {
  async create(tx: Transaction<DB>, input: CreateSyncRunInput) {
    return tx
      .insertInto("sync_runs")
      .values({
        hashtag_id: input.hashtagId,
        edge: input.edge,
        parent_run_id: input.parentRunId ?? null,
        status: "RUNNING",
        watermark_before: input.watermarkBefore,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  async updateCounters(
    tx: Transaction<DB>,
    runId: string,
    delta: { pages?: number; itemsFetched?: number; itemsNew?: number; itemsRejected?: number }
  ) {
    await tx
      .updateTable("sync_runs")
      .set((eb) => ({
        pages: delta.pages ? eb("pages", "+", delta.pages) : eb.ref("pages"),
        items_fetched: delta.itemsFetched
          ? eb("items_fetched", "+", delta.itemsFetched)
          : eb.ref("items_fetched"),
        items_new: delta.itemsNew ? eb("items_new", "+", delta.itemsNew) : eb.ref("items_new"),
        items_rejected: delta.itemsRejected
          ? eb("items_rejected", "+", delta.itemsRejected)
          : eb.ref("items_rejected"),
      }))
      .where("id", "=", runId)
      .execute();
  },

  async finish(tx: Transaction<DB>, runId: string, input: FinishSyncRunInput) {
    await tx
      .updateTable("sync_runs")
      .set({
        status: input.status,
        finished_at: new Date(),
        newest_seen_ts: input.newestSeenTs,
        oldest_seen_ts: input.oldestSeenTs,
        resume_cursor: input.resumeCursor,
        gap_status: input.gapStatus,
        error_code: input.errorCode,
        error_message: input.errorMessage,
      })
      .where("id", "=", runId)
      .execute();
  },

  async closeParentGap(tx: Transaction<DB>, parentRunId: string) {
    await tx
      .updateTable("sync_runs")
      .set({ gap_status: "closed" })
      .where("id", "=", parentRunId)
      .execute();
  },

  async findById(tx: Transaction<DB> | Kysely<DB>, runId: string) {
    return tx.selectFrom("sync_runs").selectAll().where("id", "=", runId).executeTakeFirst();
  },

  /**
   * The watermark for a new sync: the newest_seen_ts of the most recent run
   * for this hashtag/edge whose status is SUCCESS, or TRUNCATED with a
   * closed gap. Returns null when there is no such prior run (the first
   * sync ever for this edge).
   */
  async latestWatermark(
    db: Kysely<DB>,
    hashtagId: number,
    edge: SyncEdge
  ): Promise<Date | null> {
    const row = await db
      .selectFrom("sync_runs")
      .select(["newest_seen_ts"])
      .where("hashtag_id", "=", hashtagId)
      .where("edge", "=", edge)
      .where((eb) =>
        eb.or([
          eb("status", "=", "SUCCESS"),
          eb.and([eb("status", "=", "TRUNCATED"), eb("gap_status", "=", "closed")]),
        ])
      )
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row?.newest_seen_ts ?? null;
  },

  /** The most recent finished run (SUCCESS or TRUNCATED) for catch-up checks. */
  async lastFinished(db: Kysely<DB>, hashtagId: number, edge: SyncEdge) {
    return db
      .selectFrom("sync_runs")
      .selectAll()
      .where("hashtag_id", "=", hashtagId)
      .where("edge", "=", edge)
      .where("status", "in", ["SUCCESS", "TRUNCATED"])
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();
  },
};
