import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { ScriptedMetaClient, FakeClock, RecordingMetrics, FakeQueue } from "../helpers/fakes.js";
import { SyncWorker } from "../../src/workers/sync-worker.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";

const HASHTAG_ID = "17843";

describe("SyncWorker", () => {
  it("acks the queue job on a successful sync", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const clock = new FakeClock(new Date("2026-09-28T09:00:00Z"));
      const meta = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: [{ items: [], nextCursor: null, usagePct: null }] },
      });
      const queue = new FakeQueue(clock);
      await queue.enqueue("SYNC_HASHTAG_MEDIA", { hashtagId: hashtag.id, edge: "recent" });

      const worker = new SyncWorker({
        queue,
        metrics: new RecordingMetrics(),
        syncDeps: { db, meta, clock, syncMaxItems: 500, syncSkewMinutes: 10 },
      });

      const handled = await worker.runOnce();
      expect(handled).toBe(1);
      // Acked, not left in flight or re-queued — nothing left to receive.
      expect(await queue.receive(["SYNC_HASHTAG_MEDIA"], 10)).toHaveLength(0);
    });
  });

  it("releases the job with a delay when the sync throws", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-28T09:00:00Z"));
      const meta = new ScriptedMetaClient({ hashtagId: HASHTAG_ID, pagesByEdge: {} });
      const queue = new FakeQueue(clock);
      // runSync catches and gracefully handles any error thrown by
      // meta.media() itself (spec §8 error taxonomy) — that path never
      // rejects, it resolves with status: "FAILED" and the worker still
      // acks the job (a permanently-failed run shouldn't be retried
      // forever by the queue too). To exercise the worker's own
      // catch-and-release path we need a failure OUTSIDE that handled
      // scope: a job payload referencing a hashtagId that doesn't exist,
      // which makes runSync's own `executeTakeFirstOrThrow()` reject.
      await queue.enqueue("SYNC_HASHTAG_MEDIA", { hashtagId: 999999, edge: "recent" });

      const metrics = new RecordingMetrics();
      const worker = new SyncWorker({
        queue,
        metrics,
        syncDeps: { db, meta, clock, syncMaxItems: 500, syncSkewMinutes: 10 },
      });

      await worker.runOnce();
      expect(metrics.countOf("sync.job_failed")).toBe(1);
      // Not immediately visible — released with a delay.
      expect(await queue.receive(["SYNC_HASHTAG_MEDIA"], 10)).toHaveLength(0);
      clock.advance(30000);
      expect(await queue.receive(["SYNC_HASHTAG_MEDIA"], 10)).toHaveLength(1);
    });
  });

  it("handleSigterm() stops runOnce from picking up new jobs; an in-flight call it started before is unaffected", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const clock = new FakeClock(new Date("2026-09-28T09:00:00Z"));
      const meta = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: [{ items: [], nextCursor: null, usagePct: null }] },
      });
      const queue = new FakeQueue(clock);
      await queue.enqueue("SYNC_HASHTAG_MEDIA", { hashtagId: hashtag.id, edge: "recent" });

      const worker = new SyncWorker({
        queue,
        metrics: new RecordingMetrics(),
        syncDeps: { db, meta, clock, syncMaxItems: 500, syncSkewMinutes: 10 },
      });

      worker.handleSigterm();
      expect(worker.isRunning()).toBe(false);

      // A tick that starts after shutdown was requested picks up nothing new.
      const handled = await worker.runOnce();
      expect(handled).toBe(0);
      // The job is still sitting there, untouched — not lost, not stuck in flight.
      expect(await queue.receive(["SYNC_HASHTAG_MEDIA"], 10)).toHaveLength(1);
    });
  });
});
