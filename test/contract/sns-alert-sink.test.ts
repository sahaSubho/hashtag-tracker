import { describe, it, expect } from "vitest";
import { SNSClient, CreateTopicCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { localstackAwsConfig, uniqueName } from "../helpers/localstack.js";
import { SnsAlertSink } from "../../src/adapters/aws/sns-alert-sink.js";

async function makeTopicSubscribedToAQueue(): Promise<{ sink: SnsAlertSink; sqs: SQSClient; queueUrl: string }> {
  const config = await localstackAwsConfig();
  const sns = new SNSClient(config);
  const sqs = new SQSClient(config);

  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: uniqueName("topic") }));
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: uniqueName("alert-q") }));
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: QueueUrl!, AttributeNames: ["QueueArn"] })
  );
  await sns.send(
    new SubscribeCommand({ TopicArn, Protocol: "sqs", Endpoint: Attributes!.QueueArn! })
  );

  const sink = new SnsAlertSink({ client: sns, topicArn: TopicArn! });
  return { sink, sqs, queueUrl: QueueUrl! };
}

async function receiveOne(sqs: SQSClient, queueUrl: string): Promise<Record<string, unknown>> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5 })
  );
  expect(Messages).toHaveLength(1);
  // SNS wraps the published message inside its own notification envelope
  // when delivering to SQS — the actual published body is in .Message.
  const envelope = JSON.parse(Messages![0]!.Body!);
  return JSON.parse(envelope.Message);
}

describe("SnsAlertSink against real LocalStack SNS + SQS", () => {
  it("fire() publishes a message an SQS subscriber actually receives, with the alert key and severity", async () => {
    const { sink, sqs, queueUrl } = await makeTopicSubscribedToAQueue();
    await sink.fire("sync_overdue:recent", "critical", { lastSuccessAgo: "3h20m" });

    const body = await receiveOne(sqs, queueUrl);
    expect(body.event).toBe("firing");
    expect(body.alertKey).toBe("sync_overdue:recent");
    expect(body.severity).toBe("critical");
    expect(body.details).toEqual({ lastSuccessAgo: "3h20m" });
  });

  it("resolve() publishes a resolved message with no severity/details", async () => {
    const { sink, sqs, queueUrl } = await makeTopicSubscribedToAQueue();
    await sink.resolve("outbox_stalled");

    const body = await receiveOne(sqs, queueUrl);
    expect(body.event).toBe("resolved");
    expect(body.alertKey).toBe("outbox_stalled");
    expect(body.severity).toBeUndefined();
  });
});
