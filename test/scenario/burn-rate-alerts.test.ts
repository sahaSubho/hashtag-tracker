import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, RecordingAlertSink } from "../helpers/fakes.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import { runWatchdogOnce } from "../../src/services/watchdog.js";

const HASHTAG_ID = "17843";

async function seedRun(db: any, hashtagId: number, status: "SUCCESS" | "FAILED", startedAt: Date) {
  const run = await db
    .transaction()
    .execute((tx: any) => syncRunRepo.create(tx, { hashtagId, edge: "recent", watermarkBefore: null }));
  await db.updateTable("sync_runs").set({ started_at: startedAt }).where("id", "=", run.id).execute();
  await db
    .transaction()
    .execute((tx: any) =>
      syncRunRepo.finish(tx, run.id, { status, newestSeenTs: null, oldestSeenTs: null })
    );
  await db.updateTable("sync_runs").set({ finished_at: startedAt }).where("id", "=", run.id).execute();
}

describe("watchdog — freshness burn-rate alert (spec §14)", () => {
  it("pages when many runs fail within the fast (1h) window", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);

      // Every run in the last hour has failed — a fast, severe burn.
      for (let i = 0; i < 6; i++) {
        await seedRun(db, hashtag.id, "FAILED", new Date(clock.now().getTime() - i * 10 * 60000));
      }
      // Also seed one recent success so sync_overdue itself doesn't also fire and confound the assertion.
      await seedRun(db, hashtag.id, "SUCCESS", clock.now());

      const alerts = new RecordingAlertSink();
      await runWatchdogOnce({
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: 3 * 3600000,
        syncOverdueGraceMs: 15 * 60000,
        outboxStallMs: 10 * 60000,
      });

      const fired = alerts.fired.filter((f) => f.key === "freshness_burn_rate_fast");
      expect(fired).toHaveLength(1);
      expect(fired[0]?.severity).toBe("critical");
    });
  });

  it("does not page when runs are mostly succeeding", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);

      for (let i = 0; i < 6; i++) {
        await seedRun(db, hashtag.id, "SUCCESS", new Date(clock.now().getTime() - i * 10 * 60000));
      }

      const alerts = new RecordingAlertSink();
      await runWatchdogOnce({
        db,
        clock,
        alerts,
        hashtag: "matcha",
        syncIntervalMs: 3 * 3600000,
        syncOverdueGraceMs: 15 * 60000,
        outboxStallMs: 10 * 60000,
      });

      expect(alerts.fired.filter((f) => f.key === "freshness_burn_rate_fast")).toHaveLength(0);
    });
  });
});
