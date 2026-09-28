import { SNSClient, PublishCommand, type SNSClientConfig } from "@aws-sdk/client-sns";
import type { AlertSink } from "../../ports/alert-sink.js";

export interface SnsAlertSinkOptions {
  client: SNSClient | SNSClientConfig;
  topicArn: string;
}

/**
 * SNS-backed AlertSink (spec §4.1, §12.4). Publishes the alert key,
 * event, and details as a JSON message body, with `severity` also set as
 * a message attribute so subscriptions can filter on it (e.g. a
 * critical-only subscription for a pager, separate from a warnings-to-
 * Slack subscription) without every subscriber having to parse the body
 * first. Deduplication lives in the watchdog (the `alerts` table) exactly
 * as it does for LogAlertSink — this sink delivers whatever it's told,
 * exactly once per call.
 */
export class SnsAlertSink implements AlertSink {
  private readonly client: SNSClient;
  private readonly topicArn: string;

  constructor(opts: SnsAlertSinkOptions) {
    this.client = opts.client instanceof SNSClient ? opts.client : new SNSClient(opts.client);
    this.topicArn = opts.topicArn;
  }

  async fire(key: string, severity: "warning" | "critical", details: unknown): Promise<void> {
    await this.publish({ event: "firing", alertKey: key, severity, details });
  }

  async resolve(key: string): Promise<void> {
    await this.publish({ event: "resolved", alertKey: key });
  }

  private async publish(message: {
    event: "firing" | "resolved";
    alertKey: string;
    severity?: "warning" | "critical";
    details?: unknown;
  }): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(message),
        MessageAttributes: message.severity
          ? { severity: { DataType: "String", StringValue: message.severity } }
          : undefined,
      })
    );
  }
}
