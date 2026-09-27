import type { Transaction } from "kysely";
import type { DB } from "../schema.js";
import type { RejectedItem } from "../../domain/types.js";

export const rejectedRepo = {
  async insert(tx: Transaction<DB>, syncRunId: string, item: RejectedItem): Promise<void> {
    await tx
      .insertInto("rejected_items")
      .values({
        sync_run_id: syncRunId,
        ig_media_id: item.igMediaId,
        reason: item.reason,
        payload_excerpt: item.excerpt,
      })
      .execute();
  },
};
