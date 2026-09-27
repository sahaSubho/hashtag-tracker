import type { Queue, QueueJob } from "../ports/queue.js";
import type { Metrics } from "../ports/metrics.js";
import { runDownload, type DownloadServiceDeps } from "../services/download-service.js";

export interface DownloadWorkerDeps {
  queue: Queue;
  metrics: Metrics;
  downloadDeps: Omit<DownloadServiceDeps, "metrics">;
  concurrency: number;
}

interface DownloadJobPayload {
  assetId: number;
}

/**
 * Pulls DOWNLOAD_ASSET jobs off the queue, up to `concurrency` at once.
 * runDownload itself handles claim/lease/retry/dead-letter logic (spec
 * §6.4), so the worker's job here is just to keep the queue drained and
 * ack/release appropriately.
 */
export class DownloadWorker {
  private running = true;

  constructor(private readonly deps: DownloadWorkerDeps) {}

  async runOnce(): Promise<number> {
    const jobs = await this.deps.queue.receive(["DOWNLOAD_ASSET"], this.deps.concurrency);
    await Promise.all(jobs.map((job) => this.handle(job)));
    return jobs.length;
  }

  private async handle(job: QueueJob): Promise<void> {
    const payload = job.payload as DownloadJobPayload;
    try {
      await runDownload(
        { ...this.deps.downloadDeps, metrics: this.deps.metrics },
        { assetId: payload.assetId }
      );
      await this.deps.queue.ack(job);
    } catch (err) {
      this.deps.metrics.inc("download.job_failed");
      await this.deps.queue.release(job, { delayMs: 30000 });
    }
  }

  handleSigterm(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}
