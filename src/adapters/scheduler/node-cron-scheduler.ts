import cron from "node-cron";
import type { Scheduler } from "../../ports/scheduler.js";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";
import type { Clock } from "../../ports/clock.js";
import { outboxRepo } from "../../db/repositories/outbox-repo.js";
import { hashtagRepo } from "../../db/repositories/hashtag-repo.js";

export interface NodeCronSchedulerDeps {
  db: Kysely<DB>;
  clock: Clock;
  hashtag: string;
  cronExpression: string;
}

/**
 * Local scheduler adapter (spec §4.1): every SYNC_INTERVAL_CRON tick,
 * enqueues a SYNC_HASHTAG_MEDIA job for both edges through the outbox — the
 * same write path the sync service itself uses, so a job created here goes
 * through the same durability guarantees (relay, sweeper) as any other.
 * Replaced in production by EventBridge Scheduler sending to SQS directly.
 */
export class NodeCronScheduler implements Scheduler {
  private task: ReturnType<typeof cron.schedule> | undefined;

  constructor(private readonly deps: NodeCronSchedulerDeps) {}

  start(): void {
    this.task = cron.schedule(this.deps.cronExpression, () => {
      void this.enqueueSyncs();
    });
  }

  async stop(): Promise<void> {
    this.task?.stop();
  }

  private async enqueueSyncs(): Promise<void> {
    const hashtag = await hashtagRepo.findByName(this.deps.db, this.deps.hashtag);
    if (!hashtag) return; // bootstrap hasn't resolved the hashtag yet

    for (const edge of ["top", "recent"] as const) {
      await this.deps.db
        .transaction()
        .execute((tx) =>
          outboxRepo.enqueue(
            tx,
            "SYNC_HASHTAG_MEDIA",
            { hashtagId: hashtag.id, edge },
            this.deps.clock.now()
          )
        );
    }
  }
}
