import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { assetRepo } from "../../src/db/repositories/asset-repo.js";
import { outboxRepo } from "../../src/db/repositories/outbox-repo.js";
import { runRetentionOnce, deleteMediaByIgId } from "../../src/services/retention.js";
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
  raw: { some: "payload" },
  ...over,
});

describe("runRetentionOnce", () => {
  it("clears raw once raw_expires_at has passed", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "expiring" }), clock, 1));

      clock.advance(2 * 24 * 60 * 60 * 1000); // 2 days later, past the 1-day retention
      const storage = new FakeStorage();
      await runRetentionOnce({ db, clock, storage, mediaRetentionDays: 180 });

      const row = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "expiring").executeTakeFirstOrThrow();
      expect(row.raw).toBeNull();
    });
  });

  it("does not clear raw before it has expired", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "fresh" }), clock, 30));

      const storage = new FakeStorage();
      await runRetentionOnce({ db, clock, storage, mediaRetentionDays: 180 });

      const row = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "fresh").executeTakeFirstOrThrow();
      expect(row.raw).not.toBeNull();
    });
  });

  it("deletes media, its assets, and snapshots once mediaRetentionDays has passed since first_seen_at", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "old" }), clock));
      await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          { position: 0, kind: "image", sourceUrl: "https://x.fbcdn.net/a.jpg", sourceUrlExpiresAt: null, status: "pending" },
        ])
      );

      clock.advance(200 * 24 * 60 * 60 * 1000); // 200 days later
      const storage = new FakeStorage();
      await runRetentionOnce({ db, clock, storage, mediaRetentionDays: 180 });

      const row = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "old").executeTakeFirst();
      expect(row).toBeUndefined();
      const assets = await db.selectFrom("media_assets").selectAll().where("media_id", "=", mediaId).execute();
      expect(assets).toHaveLength(0);
    });
  });

  it("does not delete media before mediaRetentionDays has passed", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "recent" }), clock));

      const storage = new FakeStorage();
      await runRetentionOnce({ db, clock, storage, mediaRetentionDays: 180 });

      const row = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "recent").executeTakeFirst();
      expect(row).not.toBeUndefined();
    });
  });

  it("deletes published outbox rows older than 7 days", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const row = await db.transaction().execute((tx) => outboxRepo.enqueue(tx, "X", {}, clock.now()));
      void row;
      const claimed = await db.transaction().execute((tx) => outboxRepo.claimBatch(tx, 10, clock.now()));
      await db.transaction().execute((tx) => outboxRepo.markPublished(tx, claimed[0]!.id, clock.now()));

      clock.advance(8 * 24 * 60 * 60 * 1000);
      const storage = new FakeStorage();
      await runRetentionOnce({ db, clock, storage, mediaRetentionDays: 180 });

      const remaining = await db.selectFrom("outbox").selectAll().execute();
      expect(remaining).toHaveLength(0);
    });
  });

  it("deletes a stored asset's file only when no other asset still points to it (dedup safety)", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const storage = new FakeStorage();
      await storage.put(
        "sha256/ab/shared.jpg",
        (async function* () {
          yield new Uint8Array([1]);
        })(),
        "image/jpeg"
      );

      const { mediaId: m1 } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "share1" }), clock));
      const { mediaId: m2 } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "share2" }), clock));
      for (const mid of [m1, m2]) {
        const [asset] = await db.transaction().execute((tx) =>
          assetRepo.upsertMany(tx, mid, [
            { position: 0, kind: "image", sourceUrl: "https://x/a.jpg", sourceUrlExpiresAt: null, status: "pending" },
          ])
        );
        await db.transaction().execute((tx) =>
          assetRepo.markStored(tx, asset!.assetId, {
            contentSha256: "shared",
            storageKey: "sha256/ab/shared.jpg",
            contentType: "image/jpeg",
            bytes: 1,
            storedAt: clock.now(),
          })
        );
      }

      // Delete only one of the two posts sharing the file.
      await deleteMediaByIgId(db, storage, "share1");

      expect(await storage.exists("sha256/ab/shared.jpg")).toBe(true); // still referenced by share2
    });
  });
});

describe("deleteMediaByIgId — DELETE /internal/media/:igMediaId", () => {
  it("deletes the media row and its file when it is the only reference", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const storage = new FakeStorage();
      await storage.put(
        "sha256/cd/lonely.jpg",
        (async function* () {
          yield new Uint8Array([2]);
        })(),
        "image/jpeg"
      );
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "lonely" }), clock));
      const [asset] = await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          { position: 0, kind: "image", sourceUrl: "https://x/a.jpg", sourceUrlExpiresAt: null, status: "pending" },
        ])
      );
      await db.transaction().execute((tx) =>
        assetRepo.markStored(tx, asset!.assetId, {
          contentSha256: "lonely",
          storageKey: "sha256/cd/lonely.jpg",
          contentType: "image/jpeg",
          bytes: 1,
          storedAt: clock.now(),
        })
      );

      const deleted = await deleteMediaByIgId(db, storage, "lonely");

      expect(deleted).toBe(true);
      expect(await storage.exists("sha256/cd/lonely.jpg")).toBe(false);
      const row = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "lonely").executeTakeFirst();
      expect(row).toBeUndefined();
    });
  });

  it("returns false for an unknown ig_media_id", async () => {
    await withTestDb(async (db) => {
      const storage = new FakeStorage();
      const deleted = await deleteMediaByIgId(db, storage, "nope");
      expect(deleted).toBe(false);
    });
  });
});
