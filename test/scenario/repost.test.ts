import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeDns, FakeDownloader, FakeStorage } from "../helpers/fakes.js";
import { runDownload } from "../../src/services/download-service.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { assetRepo } from "../../src/db/repositories/asset-repo.js";
import type { MappedMedia } from "../../src/domain/types.js";
import { captionNormHash } from "../../src/domain/caption.js";
import { refreshGroupTotalsForMedia } from "../../src/services/repost-service.js";

const allowlist = ["*.cdninstagram.com", "*.fbcdn.net"];

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

function baseDeps(clock: FakeClock) {
  return {
    clock,
    metrics: { inc: () => {}, gauge: () => {}, observe: () => {} },
    hostAllowlist: allowlist,
    maxBytes: 100000,
    downloadLeaseSeconds: 120,
    downloadMaxAttempts: 5,
  };
}

async function downloadOne(
  db: any,
  clock: FakeClock,
  igMediaId: string,
  igTimestamp: string,
  caption: string | null,
  urlBody: number[]
) {
  const hash = caption ? captionNormHash(caption) : null;
  const { mediaId } = await db
    .transaction()
    .execute((tx: any) =>
      mediaRepo.upsert(tx, media({ igMediaId, igTimestamp: new Date(igTimestamp), caption, captionNormHash: hash }), clock)
    );
  const url = `https://x.fbcdn.net/${igMediaId}.jpg`;
  const [asset] = await db
    .transaction()
    .execute((tx: any) =>
      assetRepo.upsertMany(tx, mediaId, [
        { position: 0, kind: "image", sourceUrl: url, sourceUrlExpiresAt: null, status: "pending" },
      ])
    );

  const dns = new FakeDns({ "x.fbcdn.net": ["157.240.2.35"] });
  // Prefix real JPEG magic bytes (FF D8 FF E0) so file-type detection
  // succeeds; the trailing urlBody bytes are what make each fixture's
  // content hash distinct (or identical, when the test wants a byte-exact
  // repost match).
  const jpegBytes = [0xff, 0xd8, 0xff, 0xe0, ...urlBody];
  const downloader = new FakeDownloader({
    [url]: {
      status: 200,
      headers: { "content-type": "image/jpeg" },
      bodyChunks: [new Uint8Array(jpegBytes)],
    },
  });
  const storage = new FakeStorage();

  await runDownload({ db, dns, downloader, storage, ...baseDeps(clock) }, { assetId: asset!.assetId });
  return { mediaId, assetId: asset!.assetId };
}

const LONG_CAPTION =
  "the best matcha latte recipe you will ever make at home, guaranteed to impress";

describe("repost linking — failure mode C", () => {
  it("the same ig_media_id synced twice gives one row with counts updated", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "same1" }), clock));
      await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "same1", likeCount: 99 }), clock));

      const rows = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "same1").execute();
      expect(rows.length).toBe(1);
      expect(rows[0]!.like_count).toBe(99);
    });
  });

  it("a different ig_media_id with identical bytes is linked exact_bytes, one object in storage", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await downloadOne(db, clock, "orig1", "2026-09-27T08:00:00Z", null, [1, 2, 3, 4]);
      await downloadOne(db, clock, "repost1", "2026-09-27T09:00:00Z", null, [1, 2, 3, 4]);

      const orig = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "orig1").executeTakeFirstOrThrow();
      const repost = await db
        .selectFrom("media")
        .selectAll()
        .where("ig_media_id", "=", "repost1")
        .executeTakeFirstOrThrow();

      expect(repost.duplicate_of_id).toBe(orig.id);
      expect(repost.dup_reason).toBe("exact_bytes");

      const origAsset = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("media_id", "=", orig.id)
        .executeTakeFirstOrThrow();
      const repostAsset = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("media_id", "=", repost.id)
        .executeTakeFirstOrThrow();
      expect(repostAsset.storage_key).toBe(origAsset.storage_key);
    });
  });

  it("an identical long caption with the same media_type is linked caption; a short caption is not", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await downloadOne(db, clock, "orig2", "2026-09-27T08:00:00Z", LONG_CAPTION, [10, 20]);
      await downloadOne(db, clock, "repost2", "2026-09-27T09:00:00Z", LONG_CAPTION.toUpperCase(), [30, 40]);

      const orig = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "orig2").executeTakeFirstOrThrow();
      const repost = await db
        .selectFrom("media")
        .selectAll()
        .where("ig_media_id", "=", "repost2")
        .executeTakeFirstOrThrow();
      expect(repost.duplicate_of_id).toBe(orig.id);
      expect(repost.dup_reason).toBe("caption");

      // A short caption never links, even if identical.
      await downloadOne(db, clock, "shortA", "2026-09-27T10:00:00Z", "matcha 🍵", [50]);
      await downloadOne(db, clock, "shortB", "2026-09-27T10:01:00Z", "matcha 🍵", [51]);
      const shortB = await db
        .selectFrom("media")
        .selectAll()
        .where("ig_media_id", "=", "shortB")
        .executeTakeFirstOrThrow();
      expect(shortB.duplicate_of_id).toBeNull();
    });
  });

  it("an earlier-timestamped member arriving later becomes canonical", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      // The "repost" (later ig_media_id/id) actually has the EARLIER timestamp.
      await downloadOne(db, clock, "laterSeen", "2026-09-27T10:00:00Z", null, [7, 7, 7]);
      await downloadOne(db, clock, "earlierPost", "2026-09-27T05:00:00Z", null, [7, 7, 7]);

      const laterSeen = await db
        .selectFrom("media")
        .selectAll()
        .where("ig_media_id", "=", "laterSeen")
        .executeTakeFirstOrThrow();
      const earlierPost = await db
        .selectFrom("media")
        .selectAll()
        .where("ig_media_id", "=", "earlierPost")
        .executeTakeFirstOrThrow();

      // earlierPost has the earlier ig_timestamp, so it becomes canonical
      // even though laterSeen was downloaded (and thus linked) first.
      expect(earlierPost.duplicate_of_id).toBeNull();
      expect(laterSeen.duplicate_of_id).toBe(earlierPost.id);
    });
  });

  it("repost group totals equal the sum of member rows, and a repeated sync doesn't double-count", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await downloadOne(db, clock, "gorig", "2026-09-27T08:00:00Z", null, [9, 9]);
      const { mediaId: repostMediaId } = await downloadOne(
        db,
        clock,
        "grepost",
        "2026-09-27T09:00:00Z",
        null,
        [9, 9]
      );

      const orig = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "gorig").executeTakeFirstOrThrow();
      const groupId = (
        await db.selectFrom("media").select("repost_group_id").where("id", "=", orig.id).executeTakeFirstOrThrow()
      ).repost_group_id;
      expect(groupId).not.toBeNull();

      let group = await db.selectFrom("repost_groups").selectAll().where("id", "=", groupId!).executeTakeFirstOrThrow();
      expect(group.size).toBe(2);

      // Re-sync the repost (counts update) — must not re-link or inflate the
      // group size. This mirrors what sync-service.ts does in the same
      // transaction when countsChanged && !isNew: refresh the group totals
      // for that media row, since link detection only runs once.
      await db.transaction().execute(async (tx) => {
        const { mediaId } = await mediaRepo.upsert(
          tx,
          media({ igMediaId: "grepost", likeCount: 50 }),
          clock
        );
        await refreshGroupTotalsForMedia(tx, mediaId);
      });

      group = await db.selectFrom("repost_groups").selectAll().where("id", "=", groupId!).executeTakeFirstOrThrow();
      expect(group.size).toBe(2);
      expect(group.total_likes).toBe(orig.like_count! + 50);
      void repostMediaId;
    });
  });
});
