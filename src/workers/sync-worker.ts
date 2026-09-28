import type { Queue, QueueJob } from "../ports/queue.js";
import type { Metrics } from "../ports/metrics.js";
import { runSync, type SyncServiceDeps } from "../services/sync-service.js";

export interface SyncWorkerDeps {
  queue: Queue;
  metrics: Metrics;
  syncDeps: Omit<SyncServiceDeps, "metrics">;
}

interface SyncJobPayload {
  hashtagId: number;
  edge: "top" | "recent";
  parentRunId?: string;
  cursor?: string | null;
  temporaryAttempt?: number;
  truncationChainLength?: number;
}

/**
 * Pulls SYNC_HASHTAG_MEDIA jobs off the queue and runs them. On success the
 * job is acked; on failure it is released for redelivery (the underlying
 * sync is safe to re-run: media/asset upserts are idempotent, and a
 * partially-completed sync just resumes via its watermark on retry).
 */
export class SyncWorker {
  private running = true;

  constructor(private readonly deps: SyncWorkerDeps) {}

  async runOnce(): Promise<number> {
    // Checked at the very start, not inside the loop: once a job has been
    // received it is claimed/in flight, and stopping partway through would
    // abandon it mid-processing for no benefit — the sweeper already
    // recovers a job whose worker dies outright, so there's nothing this
    // check needs to protect against beyond not picking up NEW work.
    if (!this.running) return 0;
    const jobs = await this.deps.queue.receive(["SYNC_HASHTAG_MEDIA"], 1);
    for (const job of jobs) {
      await this.handle(job);
    }
    return jobs.length;
  }

  private async handle(job: QueueJob): Promise<void> {
    const payload = job.payload as SyncJobPayload;
    try {
      await runSync(
        { ...this.deps.syncDeps, metrics: this.deps.metrics },
        {
          hashtagId: payload.hashtagId,
          edge: payload.edge,
          parentRunId: payload.parentRunId,
          cursor: payload.cursor,
          temporaryAttempt: payload.temporaryAttempt,
          truncationChainLength: payload.truncationChainLength,
        }
      );
      await this.deps.queue.ack(job);
    } catch (err) {
      this.deps.metrics.inc("sync.job_failed");
      await this.deps.queue.release(job, { delayMs: 30000 });
    }
  }

  /** Stops accepting new jobs; in-flight `handle` calls are not interrupted. */
  handleSigterm(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}
