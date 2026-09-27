import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { ScriptedMetaClient, FakeClock, RecordingMetrics } from "../helpers/fakes.js";
import { runSync } from "../../src/services/sync-service.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import type { MetaPage } from "../../src/ports/meta-client.js";

const HASHTAG_ID = "17843";

function item(id: string, isoTimestamp: string, over: Record<string, unknown> = {}) {
  return {
    id,
    media_type: "IMAGE",
    permalink: `https://instagram.com/p/${id}`,
    timestamp: isoTimestamp,
    media_url: `https://x.fbcdn.net/${id}.jpg`,
    caption: `post ${id}`,
    like_count: 1,
    comments_count: 0,
    ...over,
  };
}

/** Builds N items spaced backward in time from `start`, one per `stepMinutes`. */
function itemsBackward(count: number, start: Date, stepMinutes: number, prefix = "m") {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = new Date(start.getTime() - i * stepMinutes * 60000);
    out.push(item(`${prefix}${i}`, t.toISOString()));
  }
  return out;
}

function paginate(allItems: ReturnType<typeof item>[], pageSize: number): MetaPage[] {
  const pages: MetaPage[] = [];
  for (let i = 0; i < allItems.length; i += pageSize) {
    const chunk = allItems.slice(i, i + pageSize);
    const isLast = i + pageSize >= allItems.length;
    pages.push({
      items: chunk,
      nextCursor: isLast ? null : `cursor_${i + pageSize}`,
      usagePct: null,
    });
  }
  return pages;
}

const baseDeps = (overrides: Partial<Parameters<typeof runSync>[0]> = {}) => ({
  syncMaxItems: 500,
  syncSkewMinutes: 10,
  clock: new FakeClock(new Date("2026-09-27T12:00:00Z")),
  metrics: new RecordingMetrics(),
  ...overrides,
});

describe("runSync — failure mode A (busy hashtag, 500-item cap)", () => {
  it("hitting the 500 cap marks TRUNCATED, saves the cursor, and enqueues a follow-up", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");
      const allItems = itemsBackward(520, now, 1); // 520 one-minute-apart items, newest first
      const meta = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: paginate(allItems, 25) },
      });

      const deps = { ...baseDeps(), db, meta };
      const result = await runSync(deps, { hashtagId: hashtag.id, edge: "recent" });

      expect(result.status).toBe("TRUNCATED");

      const run = await db
        .selectFrom("sync_runs")
        .selectAll()
        .where("id", "=", result.runId)
        .executeTakeFirstOrThrow();
      expect(run.gap_status).toBe("open");
      expect(run.resume_cursor).not.toBeNull();
      expect(run.items_fetched).toBe(500);

      const outboxRows = await db
        .selectFrom("outbox")
        .selectAll()
        .where("kind", "=", "SYNC_HASHTAG_MEDIA")
        .execute();
      expect(outboxRows.length).toBe(1);
      const payload = outboxRows[0]!.payload as { parentRunId: string };
      expect(payload.parentRunId).toBe(result.runId);
    });
  });

  it("the follow-up resumes from the saved cursor, stores all 700 across 28 pages, and closes the parent's gap", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");
      const allItems = itemsBackward(700, now, 1);
      const meta = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: paginate(allItems, 25) },
      });

      const deps = { ...baseDeps(), db, meta };
      const first = await runSync(deps, { hashtagId: hashtag.id, edge: "recent" });
      expect(first.status).toBe("TRUNCATED");

      const parentRun = await db
        .selectFrom("sync_runs")
        .selectAll()
        .where("id", "=", first.runId)
        .executeTakeFirstOrThrow();

      const followUp = await runSync(deps, {
        hashtagId: hashtag.id,
        edge: "recent",
        parentRunId: first.runId,
        cursor: parentRun.resume_cursor,
      });
      expect(followUp.status).toBe("SUCCESS");

      const mediaCount = await db
        .selectFrom("media")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow();
      expect(Number(mediaCount.n)).toBe(700);

      const parentAfter = await db
        .selectFrom("sync_runs")
        .selectAll()
        .where("id", "=", first.runId)
        .executeTakeFirstOrThrow();
      expect(parentAfter.gap_status).toBe("closed");
    });
  });

  it("stops when a page is entirely older than watermark - skew", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");

      // First sync establishes a watermark at `now`.
      const firstBatch = [item("seed", now.toISOString())];
      const meta1 = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: [{ items: firstBatch, nextCursor: null, usagePct: null }] },
      });
      const deps1 = { ...baseDeps(), db, meta: meta1 };
      await runSync(deps1, { hashtagId: hashtag.id, edge: "recent" });

      // Second sync: one page entirely older than watermark - skew (10 min) → caught_up.
      const olderItems = [
        item("old1", new Date(now.getTime() - 30 * 60000).toISOString()),
        item("old2", new Date(now.getTime() - 40 * 60000).toISOString()),
      ];
      const meta2 = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: {
          recent: [
            { items: olderItems, nextCursor: "should_not_be_fetched", usagePct: null },
          ],
        },
      });
      const deps2 = { ...baseDeps(), db, meta: meta2 };
      const result = await runSync(deps2, { hashtagId: hashtag.id, edge: "recent" });

      expect(result.status).toBe("SUCCESS");
      expect(meta2.requestedCursors.length).toBe(1); // never fetched a second page
    });
  });

  it("does not stop at the first already-seen id on an out-of-order page", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");

      const meta1 = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: {
          recent: [{ items: [item("seed", now.toISOString())], nextCursor: null, usagePct: null }],
        },
      });
      await runSync({ ...baseDeps(), db, meta: meta1 }, { hashtagId: hashtag.id, edge: "recent" });

      // Page 1 mixes a newer item with an older one (out of order); page 2 has only older items.
      const page1 = [
        item("new1", new Date(now.getTime() + 5 * 60000).toISOString()),
        item("old1", new Date(now.getTime() - 60 * 60000).toISOString()),
      ];
      const page2 = [item("old2", new Date(now.getTime() - 90 * 60000).toISOString())];
      const meta2 = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: {
          recent: [
            { items: page1, nextCursor: "c2", usagePct: null },
            { items: page2, nextCursor: null, usagePct: null },
          ],
        },
      });
      const result = await runSync(
        { ...baseDeps(), db, meta: meta2 },
        { hashtagId: hashtag.id, edge: "recent" }
      );

      expect(result.status).toBe("SUCCESS");
      expect(meta2.requestedCursors.length).toBe(2); // fetched page 2 despite old1 in page 1
      const stored = await db
        .selectFrom("media")
        .select("ig_media_id")
        .where("ig_media_id", "in", ["new1", "old1", "old2"])
        .execute();
      expect(stored.map((r) => r.ig_media_id).sort()).toEqual(["new1", "old1", "old2"]);
    });
  });

  it("a NUL caption on one item stores the other 24 and records one rejected item", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");
      const items = itemsBackward(25, now, 1);
      items[0] = item("bad1", now.toISOString(), { media_type: "STORY" });

      const meta = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: [{ items, nextCursor: null, usagePct: null }] },
      });
      const result = await runSync(
        { ...baseDeps(), db, meta },
        { hashtagId: hashtag.id, edge: "recent" }
      );

      expect(result.status).toBe("SUCCESS");
      const mediaCount = await db
        .selectFrom("media")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow();
      expect(Number(mediaCount.n)).toBe(24);

      const rejected = await db.selectFrom("rejected_items").selectAll().execute();
      expect(rejected.length).toBe(1);
    });
  });

  it("enqueues one DOWNLOAD_ASSET outbox row per newly pending asset", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const now = new Date("2026-09-27T12:00:00Z");
      const items = [item("d1", now.toISOString())];
      const meta = new ScriptedMetaClient({
        hashtagId: HASHTAG_ID,
        pagesByEdge: { recent: [{ items, nextCursor: null, usagePct: null }] },
      });
      await runSync({ ...baseDeps(), db, meta }, { hashtagId: hashtag.id, edge: "recent" });

      const downloadJobs = await db
        .selectFrom("outbox")
        .selectAll()
        .where("kind", "=", "DOWNLOAD_ASSET")
        .execute();
      expect(downloadJobs.length).toBe(1);
    });
  });
});
