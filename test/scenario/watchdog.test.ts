import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, RecordingAlertSink } from "../helpers/fakes.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import { outboxRepo } from "../../src/db/repositories/outbox-repo.js";
import { runWatchdogOnce } from "../../src/services/watchdog.js";

const HASHTAG_ID = "17843";
const SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;
const SYNC_OVERDUE_GRACE_MS = 15 * 60 * 1000;
const OUTBOX_STALL_MS = 10 * 60 * 1000;

async function seedFinishedRun(
  db: any,
  hashtagId: number,
  edge: "top" | "recent",
  finishedAt: Date
) {
  const run = await db
    .transaction()
    .execute((tx: any) => syncRunRepo.create(tx, { hashtagId, edge, watermarkBefore: null }));
  await db
    .transaction()
    .execute((tx: any) =>
      syncRunRepo.finish(tx, run.id, { status: "SUCCESS", newestSeenTs: null, oldestSeenTs: null })
    );
  await db
    .updateTable("sync_runs")
    .set({ finished_at: finishedAt })
    .where("id", "=", run.id)
    .execute();
}

describe("watchdog — sync_overdue (spec §12.4)", () => {
  it("no alert at 3h10m", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const finishedAt = new Date(clock.now().getTime() - (3 * 3600000 + 10 * 60000));
      await seedFinishedRun(db, hashtag.id, "recent", finishedAt);

      const alerts = new RecordingAlertSink();
      await runWatchdogOnce({
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: SYNC_INTERVAL_MS,
        syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
        outboxStallMs: OUTBOX_STALL_MS,
      });

      expect(alerts.fired.filter((f) => f.key.startsWith("sync_overdue"))).toHaveLength(0);
    });
  });

  it("alerts at 3h16m", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const finishedAt = new Date(clock.now().getTime() - (3 * 3600000 + 16 * 60000));
      await seedFinishedRun(db, hashtag.id, "recent", finishedAt);

      const alerts = new RecordingAlertSink();
      await runWatchdogOnce({
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: SYNC_INTERVAL_MS,
        syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
        outboxStallMs: OUTBOX_STALL_MS,
      });

      const fired = alerts.fired.filter((f) => f.key === "sync_overdue:recent");
      expect(fired).toHaveLength(1);
      expect(fired[0]?.severity).toBe("critical");
    });
  });

  it("does not alert while a sync is still running inside its window", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      // A run is currently RUNNING, started recently — no finished run yet
      // for "top", but the process just started, well within its window.
      await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));

      const alerts = new RecordingAlertSink();
      await runWatchdogOnce({
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: SYNC_INTERVAL_MS,
        syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
        outboxStallMs: OUTBOX_STALL_MS,
      });

      // A currently-running sync (started just now) should not be flagged
      // overdue even though it has no finished run yet.
      expect(alerts.fired.filter((f) => f.key === "sync_overdue:recent")).toHaveLength(0);
    });
  });

  it("fires once while the condition stays true, then resolves once when it clears", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const finishedAt = new Date(clock.now().getTime() - (3 * 3600000 + 16 * 60000));
      await seedFinishedRun(db, hashtag.id, "recent", finishedAt);

      const alerts = new RecordingAlertSink();
      const deps = {
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: SYNC_INTERVAL_MS,
        syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
        outboxStallMs: OUTBOX_STALL_MS,
      };

      await runWatchdogOnce(deps);
      await runWatchdogOnce(deps); // still overdue — must not fire again
      expect(alerts.fired.filter((f) => f.key === "sync_overdue:recent")).toHaveLength(1);

      // A fresh successful sync clears the condition.
      await seedFinishedRun(db, hashtag.id, "recent", clock.now());
      await runWatchdogOnce(deps);
      expect(alerts.resolved.filter((k) => k === "sync_overdue:recent")).toHaveLength(1);
    });
  });

  it("a restart does not re-send an alert that is already firing", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const finishedAt = new Date(clock.now().getTime() - (3 * 3600000 + 16 * 60000));
      await seedFinishedRun(db, hashtag.id, "recent", finishedAt);

      const deps = {
        db,
        clock,
        hashtag: "matcha",
        syncIntervalMs: SYNC_INTERVAL_MS,
        syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
        outboxStallMs: OUTBOX_STALL_MS,
      };

      const alerts1 = new RecordingAlertSink();
      await runWatchdogOnce({ ...deps, alerts: alerts1 });
      expect(alerts1.fired).toHaveLength(1);

      // Simulate a process restart: a brand new AlertSink instance, but the
      // `alerts` table (the durable state) still has the firing row.
      const alerts2 = new RecordingAlertSink();
      await runWatchdogOnce({ ...deps, alerts: alerts2 });
      expect(alerts2.fired).toHaveLength(0);
    });
  });
});

describe("watchdog — outbox_stalled (spec §12.4)", () => {
  it("an outbox row stuck for 11 minutes triggers an alert", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      await seedFinishedRun(db, hashtag.id, "recent", clock.now());
      await seedFinishedRun(db, hashtag.id, "top", clock.now());

      const staleAt = new Date(clock.now().getTime() - 11 * 60000);
      await db
        .transaction()
        .execute((tx) => outboxRepo.enqueue(tx, "DOWNLOAD_ASSET", { assetId: 1 }, staleAt));

      const alerts = new RecordingAlertSink();
      await runWatchdogOnce({
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: SYNC_INTERVAL_MS,
        syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
        outboxStallMs: OUTBOX_STALL_MS,
      });

      expect(alerts.fired.filter((f) => f.key === "outbox_stalled")).toHaveLength(1);
    });
  });

  it("does not alert when the oldest pending row is within the stall window", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      await seedFinishedRun(db, hashtag.id, "recent", clock.now());
      await seedFinishedRun(db, hashtag.id, "top", clock.now());

      await db
        .transaction()
        .execute((tx) => outboxRepo.enqueue(tx, "DOWNLOAD_ASSET", { assetId: 1 }, clock.now()));

      const alerts = new RecordingAlertSink();
      await runWatchdogOnce({
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: SYNC_INTERVAL_MS,
        syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
        outboxStallMs: OUTBOX_STALL_MS,
      });

      expect(alerts.fired.filter((f) => f.key === "outbox_stalled")).toHaveLength(0);
    });
  });
});
