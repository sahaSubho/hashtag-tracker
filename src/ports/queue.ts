export interface QueueJob {
  id: string;
  kind: string;
  payload: unknown;
}

export interface Queue {
  enqueue(kind: string, payload: unknown, opts?: { delayMs?: number }): Promise<void>;
  receive(kinds: string[], max: number): Promise<QueueJob[]>;
  ack(job: QueueJob): Promise<void>;
  release(job: QueueJob, opts?: { delayMs?: number }): Promise<void>;
}
