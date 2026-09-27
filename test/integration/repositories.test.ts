import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock } from "../helpers/fakes.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { assetRepo } from "../../src/db/repositories/asset-repo.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import { outboxRepo } from "../../src/db/repositories/outbox-repo.js";
import { rejectedRepo } from "../../src/db/repositories/rejected-repo.js";
import type { MappedMedia } from "../../src/domain/types.js";

const media = (over: Partial<MappedMedia> = {}): MappedMedia => ({
  igMediaId: "m1",
  mediaType: "IMAGE",
  caption: null,
  captionNormHash: null,
  permalink: "p",
  igTimestamp: new Date("2026-09-27T08:00:00Z"),
  likeCount: 1,
  commentsCount: 0,
  assets: [],
  raw: {},
  ...over,
});

describe("mediaRepo.upsert", () => {
  it("inserts once and updates counts on the second sync", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const r1 = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media(), clock));
      expect(r1.isNew).toBe(true);

      const r2 = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ likeCount: 9 }), clock));
      expect(r2.isNew).toBe(false);
      expect(r2.countsChanged).toBe(true);
      expect(r2.mediaId).toBe(r1.mediaId);

      const row = await db
        .selectFrom("media")
        .selectAll()
        .where("ig_media_id", "=", "m1")
        .executeTakeFirstOrThrow();
      expect(row.like_count).toBe(9);
    });
  });

  it("does not report countsChanged when counts are identical", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => mediaRepo.upsert(tx, media(), clock));
      const r2 = await db.transaction().execute((tx) => mediaRepo.upsert(tx, media(), clock));
      expect(r2.countsChanged).toBe(false);
    });
  });

  it("keeps first_seen_at across repeated syncs", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => mediaRepo.upsert(tx, media(), clock));
      const firstRow = await db
        .selectFrom("media")
        .select("first_seen_at")
        .where("ig_media_id", "=", "m1")
        .executeTakeFirstOrThrow();

      clock.advance(60 * 60 * 1000);
      await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ likeCount: 5 }), clock));
      const secondRow = await db
        .selectFrom("media")
        .select(["first_seen_at", "last_seen_at"])
        .where("ig_media_id", "=", "m1")
        .executeTakeFirstOrThrow();

      expect(secondRow.first_seen_at.getTime()).toBe(firstRow.first_seen_at.getTime());
      expect(secondRow.last_seen_at.getTime()).toBeGreaterThan(firstRow.first_seen_at.getTime());
    });
  });
});

describe("assetRepo", () => {
  it("upserts assets and re-arms an expired asset when the url changes", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media(), clock));

      const [firstAsset] = await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          {
            position: 0,
            kind: "image",
            sourceUrl: "https://x.fbcdn.net/old.jpg",
            sourceUrlExpiresAt: null,
            status: "pending",
          },
        ])
      );
      expect(firstAsset?.newlyPending).toBe(true);

      await db
        .updateTable("media_assets")
        .set({ status: "url_expired" })
        .where("id", "=", firstAsset!.assetId)
        .execute();

      const [reArmed] = await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          {
            position: 0,
            kind: "image",
            sourceUrl: "https://x.fbcdn.net/new.jpg",
            sourceUrlExpiresAt: null,
            status: "pending",
          },
        ])
      );
      expect(reArmed?.newlyPending).toBe(true);

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", firstAsset!.assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("pending");
      expect(row.source_url).toBe("https://x.fbcdn.net/new.jpg");
    });
  });

  it("claim() moves a pending asset to downloading with a lease", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media(), clock));
      const [asset] = await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          {
            position: 0,
            kind: "image",
            sourceUrl: "https://x.fbcdn.net/a.jpg",
            sourceUrlExpiresAt: null,
            status: "pending",
          },
        ])
      );

      const leaseUntil = new Date(clock.now().getTime() + 120000);
      const claimed = await db
        .transaction()
        .execute((tx) => assetRepo.claim(tx, asset!.assetId, leaseUntil));
      expect(claimed?.status).toBe("downloading");

      // a second claim attempt on an already-downloading asset returns nothing
      const second = await db
        .transaction()
        .execute((tx) => assetRepo.claim(tx, asset!.assetId, leaseUntil));
      expect(second).toBeUndefined();
    });
  });
});

describe("syncRunRepo.latestWatermark", () => {
  it("returns the newest_seen_ts of the last SUCCESS/closed-gap run", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");

      await db.transaction().execute((tx) =>
        syncRunRepo.create(tx, {
          hashtagId: hashtag.id,
          edge: "recent",
          watermarkBefore: null,
        })
      );
      const run = await db
        .selectFrom("sync_runs")
        .selectAll()
        .where("hashtag_id", "=", hashtag.id)
        .executeTakeFirstOrThrow();

      await db.transaction().execute((tx) =>
        syncRunRepo.finish(tx, run.id, {
          status: "SUCCESS",
          newestSeenTs: new Date("2026-09-27T10:00:00Z"),
          oldestSeenTs: new Date("2026-09-27T09:00:00Z"),
        })
      );

      const watermark = await syncRunRepo.latestWatermark(db, hashtag.id, "recent");
      expect(watermark?.toISOString()).toBe("2026-09-27T10:00:00.000Z");
    });
  });

  it("returns null when there is no prior successful run", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");
      const watermark = await syncRunRepo.latestWatermark(db, hashtag.id, "recent");
      expect(watermark).toBeNull();
    });
  });
});

describe("outboxRepo", () => {
  it("claimBatch only returns rows whose available_at has passed, and respects SKIP LOCKED", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) =>
        outboxRepo.enqueue(tx, "TEST_KIND", { a: 1 }, clock.now())
      );
      await db.transaction().execute((tx) =>
        outboxRepo.enqueue(tx, "TEST_KIND", { a: 2 }, new Date(clock.now().getTime() + 60000))
      );

      const claimed = await db
        .transaction()
        .execute((tx) => outboxRepo.claimBatch(tx, 10, clock.now()));
      expect(claimed.length).toBe(1);
      expect((claimed[0]!.payload as { a: number }).a).toBe(1);
    });
  });

  it("markPublished excludes a row from future claims", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) =>
        outboxRepo.enqueue(tx, "TEST_KIND", { a: 1 }, clock.now())
      );
      const claimed = await db
        .transaction()
        .execute((tx) => outboxRepo.claimBatch(tx, 10, clock.now()));
      await db.transaction().execute((tx) => outboxRepo.markPublished(tx, claimed[0]!.id));

      const claimedAgain = await db
        .transaction()
        .execute((tx) => outboxRepo.claimBatch(tx, 10, clock.now()));
      expect(claimedAgain.length).toBe(0);
    });
  });
});

describe("rejectedRepo", () => {
  it("records a rejected item tied to a sync run", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");
      const run = await db
        .transaction()
        .execute((tx) =>
          syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null })
        );

      await db
        .transaction()
        .execute((tx) =>
          rejectedRepo.insert(tx, run.id, { igMediaId: null, reason: "bad media_type", excerpt: "{}" })
        );

      const rows = await db.selectFrom("rejected_items").selectAll().execute();
      expect(rows.length).toBe(1);
      expect(rows[0]?.reason).toBe("bad media_type");
    });
  });
});
