import { describe, it, expect } from "vitest";
import { SQSClient, CreateQueueCommand } from "@aws-sdk/client-sqs";
import { localstackAwsConfig, uniqueName } from "../helpers/localstack.js";
import { SqsQueue } from "../../src/adapters/aws/sqs-queue.js";
import type { QueueJob } from "../../src/ports/queue.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real SQS (and LocalStack's emulation of it) short-polls by default — a
 * single ReceiveMessage call samples a subset of the queue's backing
 * servers and can legitimately return zero messages even when one is
 * genuinely available (this is documented SQS behavior, not a bug: our
 * SqsQueue adapter passes WaitTimeSeconds: 0 intentionally, since the
 * app's workers already poll continuously on their own interval regardless).
 * A single receive() call in a test right after a message becomes
 * available can occasionally see nothing on the first attempt, so tests
 * that assert "a message eventually becomes receivable" retry briefly
 * instead of treating the very first call as authoritative.
 */
async function receiveEventually(
  q: SqsQueue,
  kinds: string[],
  max: number,
  attempts = 5
): Promise<QueueJob[]> {
  for (let i = 0; i < attempts; i++) {
    const jobs = await q.receive(kinds, max);
    if (jobs.length > 0) return jobs;
    if (i < attempts - 1) await sleep(500);
  }
  return [];
}

async function makeTestQueue(): Promise<SqsQueue> {
  const config = await localstackAwsConfig();
  const client = new SQSClient(config);
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: uniqueName("q") })
  );
  return new SqsQueue({ client, queueUrl: QueueUrl!, visibilityTimeoutSeconds: 2 });
}

/**
 * Proves the same behaviors as test/contract/queue.contract.ts (which
 * InMemoryQueue passes) but cannot reuse that contract directly: it drives
 * delay/visibility timing with a FakeClock the test advances instantly,
 * while real SQS runs delays and visibility timeouts on real wall-clock
 * time inside the LocalStack container — no injected clock controls that.
 * So this suite uses short real delays instead.
 */
describe("SqsQueue against real LocalStack SQS", () => {
  it("delivers a job with no delay immediately", async () => {
    const q = await makeTestQueue();
    await q.enqueue("X", { a: 1 });
    const jobs = await receiveEventually(q, ["X"], 10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ a: 1 });
  });

  it("hides a delayed job until the delay elapses", async () => {
    const q = await makeTestQueue();
    await q.enqueue("X", { a: 1 }, { delayMs: 2000 });
    expect(await q.receive(["X"], 10)).toHaveLength(0);
    await sleep(2500);
    expect(await receiveEventually(q, ["X"], 10)).toHaveLength(1);
  }, 10000);

  it("does not redeliver an acked job", async () => {
    const q = await makeTestQueue();
    await q.enqueue("X", { a: 1 });
    const [job] = await q.receive(["X"], 10);
    await q.ack(job!);
    expect(await q.receive(["X"], 10)).toHaveLength(0);
  });

  it("redelivers a released job once its visibility timeout (or requested delay) elapses", async () => {
    const config = await localstackAwsConfig();
    const client = new SQSClient(config);
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: uniqueName("q") }));
    // A longer visibilityTimeoutSeconds than the earlier tests use here:
    // the original receive's own timeout must not have a chance to elapse
    // on its own before this test's explicit release() call reaches
    // LocalStack, or the release races the message's own natural
    // reappearance and the receipt handle can go stale.
    const q = new SqsQueue({ client, queueUrl: QueueUrl!, visibilityTimeoutSeconds: 30 });

    await q.enqueue("X", { a: 1 });
    const [job] = await q.receive(["X"], 10);
    await q.release(job!, { delayMs: 2000 });
    expect(await q.receive(["X"], 10)).toHaveLength(0);
    await sleep(3000);
    expect(await receiveEventually(q, ["X"], 10)).toHaveLength(1);
  }, 20000);

  it("only returns jobs of the requested kinds, and re-arms the ones it skips", async () => {
    const q = await makeTestQueue();
    await q.enqueue("X", { a: 1 });
    await q.enqueue("Y", { a: 2 });
    const jobsX = await q.receive(["X"], 10);
    expect(jobsX.map((j: QueueJob) => j.kind)).toEqual(["X"]);
    // The "Y" message must have been released back to visible, not stuck
    // invisible for the full visibility timeout, or a caller asking for Y
    // right after would wrongly see nothing.
    const jobsY = await q.receive(["Y"], 10);
    expect(jobsY.map((j: QueueJob) => j.kind)).toEqual(["Y"]);
  });
});
