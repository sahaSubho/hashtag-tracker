import type { Kysely } from "kysely";
import type { DB, SyncEdge } from "../db/schema.js";
import type { Clock } from "../ports/clock.js";
import type { AlertSink } from "../ports/alert-sink.js";
import { alertRepo } from "../db/repositories/alert-repo.js";
import { hashtagRepo } from "../db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../db/repositories/sync-run-repo.js";

export interface WatchdogDeps {
  db: Kysely<DB>;
  clock: Clock;
  alerts: AlertSink;
  hashtag: string;
  syncIntervalMs: number;
  /** Extra time beyond syncIntervalMs before "overdue" fires (spec §12.4: 3h + 15m). */
  syncOverdueGraceMs: number;
  outboxStallMs: number;
}

const EDGES: SyncEdge[] = ["top", "recent"];

/**
 * The watchdog runs periodically against Postgres, not metrics (spec
 * §12.4) — so alerting works even without a running Prometheus/CloudWatch
 * pipeline, and survives restarts, since the `alerts` table (not any
 * in-memory state) is what remembers whether a condition is already
 * firing. Each check follows the same shape: decide if the condition is
 * currently true, then call `transition` to fire/resolve exactly once per
 * state change — never on every tick while a condition holds steady.
 */
export async function runWatchdogOnce(deps: WatchdogDeps): Promise<void> {
  const { db, clock, hashtag } = deps;
  const row = await hashtagRepo.findByName(db, hashtag);
  if (!row) return; // bootstrap hasn't resolved the hashtag yet

  for (const edge of EDGES) {
    await checkSyncOverdue(deps, row.id, edge);
  }

  await checkOutboxStalled(deps);
  void clock;
}

async function checkSyncOverdue(deps: WatchdogDeps, hashtagId: number, edge: SyncEdge): Promise<void> {
  const { db, clock } = deps;
  const key = `sync_overdue:${edge}`;

  const running = await db
    .selectFrom("sync_runs")
    .select("started_at")
    .where("hashtag_id", "=", hashtagId)
    .where("edge", "=", edge)
    .where("status", "=", "RUNNING")
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const lastFinished = await syncRunRepo.lastFinished(db, hashtagId, edge);
  const referenceTime = running?.started_at ?? lastFinished?.finished_at ?? lastFinished?.started_at ?? null;

  const thresholdMs = deps.syncIntervalMs + deps.syncOverdueGraceMs;
  const isOverdue = referenceTime === null ? false : clock.now().getTime() - referenceTime.getTime() > thresholdMs;

  await transition(deps, key, isOverdue, "critical", { edge, hashtagId });
}

async function checkOutboxStalled(deps: WatchdogDeps): Promise<void> {
  const { db, clock } = deps;
  const key = "outbox_stalled";

  const oldest = await db
    .selectFrom("outbox")
    .select("available_at")
    .where("published_at", "is", null)
    .orderBy("available_at", "asc")
    .limit(1)
    .executeTakeFirst();

  const isStalled =
    oldest !== undefined && clock.now().getTime() - oldest.available_at.getTime() > deps.outboxStallMs;

  await transition(deps, key, isStalled, "critical", {});
}

/**
 * Fires or resolves an alert exactly once per state transition, using the
 * `alerts` table as durable dedup state so a restart never re-sends an
 * alert that's already firing, and a resolve is sent exactly once when the
 * condition clears.
 */
async function transition(
  deps: WatchdogDeps,
  key: string,
  isActive: boolean,
  severity: "warning" | "critical",
  details: unknown
): Promise<void> {
  const { db, clock, alerts } = deps;
  const existing = await alertRepo.findByKey(db, key);
  const alreadyFiring = existing?.state === "firing";

  if (isActive && !alreadyFiring) {
    await alertRepo.upsertFiring(db, key, clock.now(), details);
    await alerts.fire(key, severity, details);
  } else if (!isActive && alreadyFiring) {
    await alertRepo.markResolved(db, key, clock.now());
    await alerts.resolve(key);
  }
  // isActive && alreadyFiring -> stays firing, no re-notify.
  // !isActive && !alreadyFiring (or no row) -> nothing to do.
}
