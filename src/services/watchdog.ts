import type { Kysely } from "kysely";
import type { DB, SyncEdge } from "../db/schema.js";
import type { Clock } from "../ports/clock.js";
import type { AlertSink } from "../ports/alert-sink.js";
import { alertRepo } from "../db/repositories/alert-repo.js";
import { hashtagRepo } from "../db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../db/repositories/sync-run-repo.js";
import { computeBurnRate } from "../domain/slo.js";

const SLO_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FRESHNESS_SLO_TARGET = 0.99;

/** spec §14: page at 14.4x burn over a 1h window, ticket at 6x over a 6h window. */
const FAST_WINDOW_MS = 60 * 60 * 1000;
const FAST_BURN_THRESHOLD = 14.4;
const SLOW_WINDOW_MS = 6 * 60 * 60 * 1000;
const SLOW_BURN_THRESHOLD = 6;

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
  await checkFreshnessBurnRate(deps, row.id, "fast", FAST_WINDOW_MS, FAST_BURN_THRESHOLD, "critical");
  await checkFreshnessBurnRate(deps, row.id, "slow", SLOW_WINDOW_MS, SLOW_BURN_THRESHOLD, "warning");
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

/**
 * SLO burn-rate alerting (spec §14): rather than paging on a single failed
 * sync, this looks at the recent failure ratio and asks "at this rate, how
 * fast is the 30-day error budget being spent?" A single isolated miss
 * burns the budget too slowly to trip either threshold; a sustained run of
 * failures does.
 */
async function checkFreshnessBurnRate(
  deps: WatchdogDeps,
  hashtagId: number,
  label: "fast" | "slow",
  windowMs: number,
  threshold: number,
  severity: "warning" | "critical"
): Promise<void> {
  const { db, clock } = deps;
  const key = `freshness_burn_rate_${label}`;
  const windowStart = new Date(clock.now().getTime() - windowMs);

  const runs = await db
    .selectFrom("sync_runs")
    .select(["status", "gap_status"])
    .where("hashtag_id", "=", hashtagId)
    .where("started_at", ">=", windowStart)
    .where("status", "!=", "RUNNING")
    .execute();

  if (runs.length === 0) {
    await transition(deps, key, false, severity, {});
    return;
  }

  const badCount = runs.filter(
    (r) => !(r.status === "SUCCESS" || (r.status === "TRUNCATED" && r.gap_status === "closed"))
  ).length;
  const errorRatioInWindow = badCount / runs.length;

  const burnRate = computeBurnRate({
    errorRatioInWindow,
    sloTarget: FRESHNESS_SLO_TARGET,
    windowFractionOfSloPeriod: windowMs / SLO_PERIOD_MS,
  });

  await transition(deps, key, burnRate >= threshold, severity, { burnRate, badCount, total: runs.length });
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
