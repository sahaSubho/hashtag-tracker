import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";
import type { Queue, QueueJob } from "../../ports/queue.js";

const SQS_MAX_MESSAGES_PER_CALL = 10;
const SQS_MAX_DELAY_SECONDS = 900; // SQS's own ceiling (15 min); longer delays are handled at the outbox layer (spec §8)
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 120;

export interface SqsQueueOptions {
  client: SQSClient | SQSClientConfig;
  queueUrl: string;
  visibilityTimeoutSeconds?: number;
}

/**
 * SQS-backed Queue implementation (spec §4.1, §15.1). Delays beyond SQS's
 * 900s ceiling are never requested here — the outbox already stores
 * longer delays as `available_at` and only enqueues to this Queue once a
 * job is actually due (spec §8), so this adapter's job is simply to clamp
 * defensively, not to implement its own long-delay mechanism.
 *
 * `QueueJob.id` is a composite `<messageId>:<receiptHandle>` string: SQS's
 * delete/visibility-change APIs need the receipt handle (which changes on
 * every receive), not the stable message ID, so the handle has to travel
 * with the job somehow. Encoding it into `id` (rather than an in-memory
 * side-map) keeps this adapter stateless across process restarts — a real
 * production requirement an in-memory map would quietly violate.
 */
export class SqsQueue implements Queue {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly visibilityTimeoutSeconds: number;

  constructor(opts: SqsQueueOptions) {
    this.client = opts.client instanceof SQSClient ? opts.client : new SQSClient(opts.client);
    this.queueUrl = opts.queueUrl;
    this.visibilityTimeoutSeconds = opts.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
  }

  async enqueue(kind: string, payload: unknown, opts?: { delayMs?: number }): Promise<void> {
    const delaySeconds = Math.min(
      SQS_MAX_DELAY_SECONDS,
      Math.max(0, Math.round((opts?.delayMs ?? 0) / 1000))
    );
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(payload),
        DelaySeconds: delaySeconds,
        MessageAttributes: {
          kind: { DataType: "String", StringValue: kind },
        },
      })
    );
  }

  async receive(kinds: string[], max: number): Promise<QueueJob[]> {
    const results: QueueJob[] = [];
    const toReleaseImmediately: string[] = [];

    while (results.length < max) {
      const batchSize = Math.min(SQS_MAX_MESSAGES_PER_CALL, max - results.length);
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: batchSize,
          MessageAttributeNames: ["kind"],
          VisibilityTimeout: this.visibilityTimeoutSeconds,
          WaitTimeSeconds: 0,
        })
      );

      const messages = response.Messages ?? [];
      if (messages.length === 0) break; // nothing more waiting right now

      for (const message of messages) {
        const kind = message.MessageAttributes?.kind?.StringValue ?? "";
        if (!kinds.includes(kind)) {
          // Not a kind this caller wants — make it visible again right
          // away rather than leaving it invisible for the full timeout,
          // so another caller asking for the right kind isn't blocked.
          if (message.ReceiptHandle) toReleaseImmediately.push(message.ReceiptHandle);
          continue;
        }
        results.push({
          id: `${message.MessageId}:${message.ReceiptHandle}`,
          kind,
          payload: message.Body ? JSON.parse(message.Body) : undefined,
        });
      }

      if (messages.length < batchSize) break; // queue is drained for now
    }

    await Promise.all(
      toReleaseImmediately.map((receiptHandle) =>
        this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 0,
          })
        )
      )
    );

    return results;
  }

  async ack(job: QueueJob): Promise<void> {
    const receiptHandle = receiptHandleOf(job);
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle })
    );
  }

  async release(job: QueueJob, opts?: { delayMs?: number }): Promise<void> {
    const receiptHandle = receiptHandleOf(job);
    const delaySeconds = Math.min(
      SQS_MAX_DELAY_SECONDS,
      Math.max(0, Math.round((opts?.delayMs ?? 0) / 1000))
    );
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: delaySeconds,
      })
    );
  }
}

function receiptHandleOf(job: QueueJob): string {
  const idx = job.id.indexOf(":");
  if (idx < 0) {
    throw new Error(`SqsQueue: job id "${job.id}" is not a <messageId>:<receiptHandle> pair`);
  }
  return job.id.slice(idx + 1);
}
