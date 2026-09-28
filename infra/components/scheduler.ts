import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface SyncScheduleArgs {
  namePrefix: string;
  queueArn: pulumi.Input<string>;
  cronExpression?: string;
  hashtagId: pulumi.Input<string>;
}

/**
 * The real schedule for production (spec §4.1, §15.1): an EventBridge
 * Scheduler rule that sends a SYNC_HASHTAG_MEDIA message directly to SQS
 * every 3 hours, for both edges. Nothing in the running application
 * process creates or owns this — it exists entirely here, which is why
 * `EventBridgeScheduler` (src/adapters/aws/eventbridge-scheduler.ts) is a
 * no-op placeholder: this resource is what actually replaces
 * NodeCronScheduler in production.
 */
export class SyncSchedule extends pulumi.ComponentResource {
  public readonly role: aws.iam.Role;
  public readonly schedules: aws.scheduler.Schedule[];

  constructor(args: SyncScheduleArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:SyncSchedule", `${args.namePrefix}-sync-schedule`, {}, opts);

    this.role = new aws.iam.Role(
      `${args.namePrefix}-scheduler-role`,
      {
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "scheduler.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      { parent: this }
    );

    new aws.iam.RolePolicy(
      `${args.namePrefix}-scheduler-send-message`,
      {
        role: this.role.id,
        policy: pulumi.output(args.queueArn).apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: arn }],
          })
        ),
      },
      { parent: this }
    );

    const cron = args.cronExpression ?? "rate(3 hours)"; // matches spec §17's default SYNC_INTERVAL_CRON, "0 */3 * * *"

    this.schedules = (["top", "recent"] as const).map(
      (edge) =>
        new aws.scheduler.Schedule(
          `${args.namePrefix}-sync-${edge}`,
          {
            flexibleTimeWindow: { mode: "OFF" },
            scheduleExpression: cron,
            target: {
              arn: args.queueArn, // EventBridge Scheduler's SQS target identifies the queue by ARN, not its URL
              roleArn: this.role.arn,
              input: pulumi.output(args.hashtagId).apply((hashtagId) =>
                JSON.stringify({ hashtagId: Number(hashtagId), edge })
              ),
            },
          },
          { parent: this }
        )
    );

    this.registerOutputs({ scheduleNames: this.schedules.map((s) => s.name) });
  }
}
