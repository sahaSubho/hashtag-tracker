import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, RecordingAlertSink } from "../helpers/fakes.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import { runWatchdogOnce } from "../../src/services/watchdog.js";

const HASHTAG_ID = "17843";

describe("watchdog — unrecoverable gap detection (spec §6.2, §12.4)", () => {
  it("marks an open gap unrecoverable once it is older than 24h and alerts critical", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);

      const oldestSeenTs = new Date(clock.now().getTime() - 25 * 3600000); // 25h old gap
      const run = await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));
      await db
        .transaction()
        .execute((tx) =>
          syncRunRepo.finish(tx, run.id, {
            status: "TRUNCATED",
            newestSeenTs: clock.now(),
            oldestSeenTs,
            gapStatus: "open",
          })
        );

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

      const updated = await db.selectFrom("sync_runs").selectAll().where("id", "=", run.id).executeTakeFirstOrThrow();
      expect(updated.gap_status).toBe("unrecoverable");

      const fired = alerts.fired.filter((f) => f.key === "sync_gap_unrecoverable");
      expect(fired).toHaveLength(1);
      expect(fired[0]?.severity).toBe("critical");
    });
  });

  it("does not mark a gap unrecoverable before 24h have passed", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);

      const oldestSeenTs = new Date(clock.now().getTime() - 10 * 3600000); // 10h old — within the window
      const run = await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));
      await db
        .transaction()
        .execute((tx) =>
          syncRunRepo.finish(tx, run.id, {
            status: "TRUNCATED",
            newestSeenTs: clock.now(),
            oldestSeenTs,
            gapStatus: "open",
          })
        );

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

      const updated = await db.selectFrom("sync_runs").selectAll().where("id", "=", run.id).executeTakeFirstOrThrow();
      expect(updated.gap_status).toBe("open");
      expect(alerts.fired.filter((f) => f.key === "sync_gap_unrecoverable")).toHaveLength(0);
    });
  });

  it("does not touch a gap that has already closed", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);

      const oldestSeenTs = new Date(clock.now().getTime() - 25 * 3600000);
      const run = await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));
      await db
        .transaction()
        .execute((tx) =>
          syncRunRepo.finish(tx, run.id, {
            status: "TRUNCATED",
            newestSeenTs: clock.now(),
            oldestSeenTs,
            gapStatus: "closed",
          })
        );

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

      const updated = await db.selectFrom("sync_runs").selectAll().where("id", "=", run.id).executeTakeFirstOrThrow();
      expect(updated.gap_status).toBe("closed");
    });
  });
});
