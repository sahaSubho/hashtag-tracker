import type { Scheduler } from "../../ports/scheduler.js";

export interface EventBridgeSchedulerDeps {
  logger: { warn(obj: unknown, msg: string): void };
}

/**
 * Placeholder Scheduler for production (spec §15.1). Unlike
 * NodeCronScheduler, there is nothing for this class to actually do at
 * runtime: the schedule itself is an EventBridge Scheduler rule created by
 * the Pulumi stack (infra/, P4-03) at deploy time, pointing directly at
 * the SQS queue — no running process creates, owns, or ticks it.
 *
 * This class exists only so index.ts's role-based wiring can construct
 * *something* satisfying the Scheduler interface when config selects the
 * AWS scheduler backend. In a real ECS deployment the "scheduler" app
 * role should be disabled entirely (EventBridge replaces it, spec §15.1's
 * service table has no scheduler process) — start() logs a loud warning
 * if it's ever actually invoked, since that means the role wiring itself
 * is misconfigured, not that anything here needs to run.
 */
export class EventBridgeScheduler implements Scheduler {
  constructor(private readonly deps: EventBridgeSchedulerDeps) {}

  start(): void {
    this.deps.logger.warn(
      {},
      "EventBridgeScheduler.start() called — this is a no-op placeholder. " +
        "The real schedule is an EventBridge rule created by the Pulumi stack at deploy " +
        "time, not by this running process. If you're seeing this, the 'scheduler' app " +
        "role should not be enabled in this deployment."
    );
  }

  async stop(): Promise<void> {
    // Nothing to stop — see the class-level comment.
  }
}
