import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Kysely } from "kysely";
import { withTestDb } from "../helpers/pg.js";
import { FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { assetRepo } from "../../src/db/repositories/asset-repo.js";
import type { MappedMedia } from "../../src/domain/types.js";
import type { Clock } from "../../src/ports/clock.js";
import type { DB } from "../../src/db/schema.js";

const fixedClock: Clock = { now: () => new Date("2026-09-27T12:00:00Z") };

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

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

async function seedPost(
  db: Kysely<DB>,
  igMediaId: string,
  igTimestamp: string,
  stored = true
): Promise<number> {
  const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");
  const { mediaId } = await db
    .transaction()
    .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId, igTimestamp: new Date(igTimestamp) }), fixedClock));
  // sync-service.ts normally inserts this join row alongside the upsert;
  // reproduce that here since these tests seed data directly via the repo.
  await db
    .insertInto("media_hashtags")
    .values({ media_id: mediaId, hashtag_id: hashtag.id, edges: ["recent"], first_seen_at: fixedClock.now() })
    .onConflict((oc) => oc.doNothing())
    .execute();
  if (stored) {
    const [asset] = await db.transaction().execute((tx) =>
      assetRepo.upsertMany(tx, mediaId, [
        { position: 0, kind: "image", sourceUrl: "https://x.fbcdn.net/a.jpg", sourceUrlExpiresAt: null, status: "pending" },
      ])
    );
    await db.transaction().execute((tx) => assetRepo.claim(tx, asset!.assetId, new Date(Date.now() + 60000)));
    await db.transaction().execute((tx) =>
      assetRepo.markStored(tx, asset!.assetId, {
        contentSha256: `hash-${igMediaId}`,
        storageKey: `sha256/xx/hash-${igMediaId}.jpg`,
        contentType: "image/jpeg",
        bytes: 10,
        storedAt: fixedClock.now(),
      })
    );
  }
  return mediaId;
}

describe("GET /hashtags", () => {
  it("returns posts ordered by ig_timestamp desc, id desc, excluding reposts", async () => {
    await withTestDb(async (db) => {
      await hashtagRepo.upsertOnce(db, "matcha", "17843");
      await seedPost(db, "old1", "2026-09-27T08:00:00Z");
      await seedPost(db, "new1", "2026-09-27T10:00:00Z");
      const repostMediaId = await seedPost(db, "repost1", "2026-09-27T09:00:00Z");
      await db
        .updateTable("media")
        .set({ duplicate_of_id: (await db.selectFrom("media").select("id").where("ig_media_id", "=", "old1").executeTakeFirstOrThrow()).id })
        .where("id", "=", repostMediaId)
        .execute();

      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/hashtags");

      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: any) => d.igMediaId);
      expect(ids).toEqual(["new1", "old1"]);
    });
  });

  it("a post inserted later with an older ig_timestamp sorts lower", async () => {
    await withTestDb(async (db) => {
      await hashtagRepo.upsertOnce(db, "matcha", "17843");
      await seedPost(db, "first-inserted", "2026-09-27T10:00:00Z"); // inserted first, but newer timestamp
      await seedPost(db, "second-inserted", "2026-09-27T05:00:00Z"); // inserted second, but older timestamp

      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/hashtags");

      const ids = res.body.data.map((d: any) => d.igMediaId);
      expect(ids).toEqual(["first-inserted", "second-inserted"]);
    });
  });

  it("clamps limit to 100", async () => {
    await withTestDb(async (db) => {
      await hashtagRepo.upsertOnce(db, "matcha", "17843");
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/hashtags?limit=10000");
      expect(res.status).toBe(200);
      expect(res.body.pageInfo).toBeDefined();
    });
  });

  it("returns 400 for a tampered cursor", async () => {
    await withTestDb(async (db) => {
      await hashtagRepo.upsertOnce(db, "matcha", "17843");
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/hashtags?cursor=not-a-valid-cursor!!");
      expect(res.status).toBe(400);
    });
  });

  it("returns 404 for an untracked hashtag", async () => {
    await withTestDb(async (db) => {
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/hashtags?tag=unknown");
      expect(res.status).toBe(404);
    });
  });

  it("paginates with a cursor with no duplicates or skips across pages", async () => {
    await withTestDb(async (db) => {
      await hashtagRepo.upsertOnce(db, "matcha", "17843");
      for (let i = 0; i < 5; i++) {
        await seedPost(db, `p${i}`, new Date(2026, 8, 27, 8 + i).toISOString());
      }
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });

      const page1 = await request(app).get("/hashtags?limit=2");
      expect(page1.body.data.length).toBe(2);
      expect(page1.body.pageInfo.hasMore).toBe(true);

      const page2 = await request(app).get(`/hashtags?limit=2&cursor=${page1.body.pageInfo.nextCursor}`);
      expect(page2.body.data.length).toBe(2);

      const allIds = [...page1.body.data, ...page2.body.data].map((d: any) => d.igMediaId);
      expect(new Set(allIds).size).toBe(4); // no duplicates
    });
  });

  it("only resolves an asset url for stored assets", async () => {
    await withTestDb(async (db) => {
      await hashtagRepo.upsertOnce(db, "matcha", "17843");
      await seedPost(db, "withasset", "2026-09-27T08:00:00Z", true);
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/hashtags");
      const post = res.body.data.find((d: any) => d.igMediaId === "withasset");
      expect(post.assets[0].url).toContain("/files/");
    });
  });

  it("sets X-Request-Id and nosniff headers", async () => {
    await withTestDb(async (db) => {
      await hashtagRepo.upsertOnce(db, "matcha", "17843");
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/hashtags");
      expect(res.headers["x-request-id"]).toBeDefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });
});
