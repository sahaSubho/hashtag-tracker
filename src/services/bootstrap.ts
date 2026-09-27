import type { Kysely } from "kysely";
import type { DB, SyncEdge } from "../db/schema.js";
import type { MetaClient } from "../ports/meta-client.js";
import type { Clock } from "../ports/clock.js";
import { hashtagRepo } from "../db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../db/repositories/sync-run-repo.js";
import { outboxRepo } from "../db/repositories/outbox-repo.js";

export interface BootstrapDeps {
  db: Kysely<DB>;
  meta: MetaClient;
  clock: Clock;
  hashtag: string;
  syncIntervalMs: number;
}

const EDGES: SyncEdge[] = ["top", "recent"];

/**
 * Runs at process startup (spec §6.1): ensures the tracked hashtag's
 * ig_hashtag_id is resolved and stored (searchHashtag runs at most once,
 * ever, per hashtag — this is the fix for Meta's 30-hashtags-per-week
 * budget), then enqueues a catch-up sync for any edge whose last
 * successful/truncated run is older than the sync interval — recovering
 * from a missed cron window while the process was down (failure mode D).
 */
export async function bootstrap(deps: BootstrapDeps): Promise<void> {
  const { db, meta, clock, hashtag, syncIntervalMs } = deps;

  let row = await hashtagRepo.findByName(db, hashtag);
  if (!row) {
    const igHashtagId = await meta.searchHashtag(hashtag);
    row = await hashtagRepo.upsertOnce(db, hashtag, igHashtagId);
  }

  for (const edge of EDGES) {
    const lastFinished = await syncRunRepo.lastFinished(db, row.id, edge);
    const referenceTime = lastFinished?.finished_at ?? lastFinished?.started_at ?? null;
    const isOverdue =
      !referenceTime || clock.now().getTime() - referenceTime.getTime() > syncIntervalMs;

    if (isOverdue) {
      await db
        .transaction()
        .execute((tx) =>
          outboxRepo.enqueue(
            tx,
            "SYNC_HASHTAG_MEDIA",
            { hashtagId: row!.id, edge },
            clock.now()
          )
        );
    }
  }
}
