import type { Logger } from "pino";
import type { AlertSink } from "../../ports/alert-sink.js";

export interface LogAlertSinkOptions {
  logger: Logger;
  slackWebhookUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Local AlertSink (spec §4.1): logs at "alert" severity, and optionally
 * posts to a Slack webhook. Deduplication itself lives in the watchdog
 * (backed by the `alerts` table) — this sink just delivers whatever it's
 * told to, exactly once per call.
 */
export class LogAlertSink implements AlertSink {
  constructor(private readonly opts: LogAlertSinkOptions) {}

  async fire(key: string, severity: "warning" | "critical", details: unknown): Promise<void> {
    this.opts.logger.error({ alertKey: key, severity, details }, `ALERT FIRING: ${key}`);
    await this.postToSlack(`:rotating_light: *${severity.toUpperCase()}* \`${key}\` firing`);
  }

  async resolve(key: string): Promise<void> {
    this.opts.logger.info({ alertKey: key }, `ALERT RESOLVED: ${key}`);
    await this.postToSlack(`:white_check_mark: \`${key}\` resolved`);
  }

  private async postToSlack(text: string): Promise<void> {
    if (!this.opts.slackWebhookUrl) return;
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      await doFetch(this.opts.slackWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      this.opts.logger.warn({ err }, "failed to post alert to Slack");
    }
  }
}
