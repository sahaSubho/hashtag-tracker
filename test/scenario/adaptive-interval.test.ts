import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { ScriptedMetaClient, FakeClock, RecordingMetrics } from "../helpers/fakes.js";
import { runSync } from "../../src/services/sync-service.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import type { MetaPage } from "../../src/ports/meta-client.js";

const HASHTAG_ID = "17843";

function item(id: string, isoTimestamp: string) {
  return {
    id,
    media_type: "IMAGE",
    permalink: `https://instagram.com/p/${id}`,
    timestamp: isoTimestamp,
    media_url: `https://x.fbcdn.net/${id}.jpg`,
    like_count: 1,
    comments_count: 0,
  };
}

function itemsBackward(count: number, start: Date, stepMinutes: number, prefix = "m") {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(item(`${prefix}${i}`, new Date(start.getTime() - i * stepMinutes * 60000).toISOString()));
  }
  return out;
}

function paginate(items: ReturnType<typeof item>[], pageSize: number): MetaPage[] {
  const pages: MetaPage[] = [];
  for (let i = 0; i < items.length; i += pageSize) {
    const chunk = items.slice(i, i + pageSize);
    const isLast = i + pageSize >= items.length;
    pages.push({ items: chunk, nextCursor: isLast ? null : `c_${i + pageSize}`, usagePct: null });
  }
  return pages;
}

describe("adaptive interval — extra sync after consecutive truncations (spec §7-A)", () => {
  it("after 2 consecutive truncated runs, an extra sync is enqueued sooner than the normal interval", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");
      const clock = new FakeClock(now);

      // First run: 520 items -> truncated (1st truncation for this chain).
      const meta1 = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: paginate(itemsBackward(520, now, 1), 25) },
      });
      const first = await runSync(
        { db, meta: meta1, clock, metrics: new RecordingMetrics(), syncMaxItems: 500, syncSkewMinutes: 10 },
        { hashtagId: hashtag.id, edge: "recent" }
      );
      expect(first.status).toBe("TRUNCATED");

      // Follow-up (2nd truncation in the chain): still more than the cap left.
      const parentRun = await db.selectFrom("sync_runs").selectAll().where("id", "=", first.runId).executeTakeFirstOrThrow();
      const meta2 = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: paginate(itemsBackward(520, now, 1, "n"), 25) },
      });
      const second = await runSync(
        { db, meta: meta2, clock, metrics: new RecordingMetrics(), syncMaxItems: 500, syncSkewMinutes: 10 },
        { hashtagId: hashtag.id, edge: "recent", parentRunId: first.runId, cursor: parentRun.resume_cursor, truncationChainLength: 1 }
      );
      expect(second.status).toBe("TRUNCATED");

      // The follow-up job enqueued after the 2nd consecutive truncation
      // should be scheduled sooner than the normal 3h interval.
      const outboxRows = await db
        .selectFrom("outbox")
        .selectAll()
        .where("kind", "=", "SYNC_HASHTAG_MEDIA")
        .orderBy("id", "desc")
        .limit(1)
        .execute();
      const payload = outboxRows[0]!.payload as { truncationChainLength?: number };
      expect(payload.truncationChainLength).toBe(2);

      const delayMs = new Date(outboxRows[0]!.available_at).getTime() - clock.now().getTime();
      expect(delayMs).toBeGreaterThan(0);
      expect(delayMs).toBeLessThan(3 * 3600000); // sooner than the normal cron interval
    });
  });

  it("a single truncation does not trigger the adaptive shortening (delay stays at 0 for the first)", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");
      const clock = new FakeClock(now);
      const meta = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: paginate(itemsBackward(520, now, 1), 25) },
      });

      const result = await runSync(
        { db, meta, clock, metrics: new RecordingMetrics(), syncMaxItems: 500, syncSkewMinutes: 10 },
        { hashtagId: hashtag.id, edge: "recent" }
      );
      expect(result.status).toBe("TRUNCATED");

      const outboxRows = await db
        .selectFrom("outbox")
        .selectAll()
        .where("kind", "=", "SYNC_HASHTAG_MEDIA")
        .execute();
      const payload = outboxRows[0]!.payload as { truncationChainLength?: number };
      expect(payload.truncationChainLength).toBe(1);
    });
  });
});
