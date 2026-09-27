import type { Queue, QueueJob } from "../../ports/queue.js";
import type { Clock } from "../../ports/clock.js";

interface InternalJob extends QueueJob {
  availableAt: number;
}

/**
 * Local Queue implementation (spec §4.1): an in-memory job list, honoring
 * delayMs against the injected Clock. It has no visibility timeout the way
 * SQS does — a job taken by `receive` and never acked/released just stays
 * out of circulation — which is exactly why the sweeper (spec §6.7) exists
 * to recover assets whose download job never finished. Replaced by SQS in
 * production behind the same interface.
 */
export class InMemoryQueue implements Queue {
  private jobs: InternalJob[] = [];
  private inFlight = new Map<string, InternalJob>();
  private nextId = 1;

  constructor(private readonly clock: Clock) {}

  async enqueue(kind: string, payload: unknown, opts?: { delayMs?: number }): Promise<void> {
    const availableAt = this.clock.now().getTime() + (opts?.delayMs ?? 0);
    this.jobs.push({ id: String(this.nextId++), kind, payload, availableAt });
  }

  async receive(kinds: string[], max: number): Promise<QueueJob[]> {
    const now = this.clock.now().getTime();
    const eligible = this.jobs.filter((j) => kinds.includes(j.kind) && j.availableAt <= now);
    const taken = eligible.slice(0, max);
    this.jobs = this.jobs.filter((j) => !taken.includes(j));
    for (const job of taken) this.inFlight.set(job.id, job);
    return taken.map(({ availableAt: _availableAt, ...job }) => job);
  }

  async ack(job: QueueJob): Promise<void> {
    this.inFlight.delete(job.id);
  }

  async release(job: QueueJob, opts?: { delayMs?: number }): Promise<void> {
    this.inFlight.delete(job.id);
    const availableAt = this.clock.now().getTime() + (opts?.delayMs ?? 0);
    this.jobs.push({ id: job.id, kind: job.kind, payload: job.payload, availableAt });
  }
}
