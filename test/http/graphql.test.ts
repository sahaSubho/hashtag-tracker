import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { makeCountingDb } from "../helpers/query-counter.js";
import { createApp } from "../../src/http/app.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";
import { generateApiKey, hashApiKeySecret } from "../../src/domain/api-key.js";
import type { MappedMedia } from "../../src/domain/types.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

async function seedDashboardKey(db: any) {
  const { plaintext, keyId, secret } = generateApiKey();
  await apiKeyRepo.create(db, {
    keyId,
    hash: hashApiKeySecret(secret),
    name: "test-dashboard",
    scopes: ["dashboard:read"],
  });
  return plaintext;
}

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

async function graphqlRequest(app: ReturnType<typeof createApp>, key: string, query: string, variables?: unknown) {
  return request(app)
    .post("/graphql")
    .set("Authorization", `Bearer ${key}`)
    .send({ query, variables });
}

describe("GraphQL dashboard API", () => {
  it("401s without an API key", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        readDb: db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
      });
      const res = await request(app).post("/graphql").send({ query: "{ posts(first: 1) { edges { node { id } } } }" });
      expect(res.status).toBe(401);
    });
  });

  it("403s with a key that lacks dashboard:read", async () => {
    await withTestDb(async (db) => {
      const { plaintext, keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "wrong-scope", scopes: ["admin"] });
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await graphqlRequest(app, plaintext, "{ posts(first: 1) { edges { node { id } } } }");
      expect(res.status).toBe(403);
    });
  });

  it("fetching posts with assets and repost groups runs at most 3 SQL statements", async () => {
    await withTestDb(async (db, connectionString) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const storage = new FakeStorage();

      // Seed 20 posts, each with one stored asset; link every 5th into a
      // repost group directly (bypassing the download pipeline — this test
      // is about query counting, not re-testing repost linking). 20, not
      // 50: with assets+repostGroup both selected, graphql-armor's cost
      // limit (P3-04, maxCost 1000) legitimately rejects first:50 for this
      // shape of query — the N+1 property this test proves holds at any
      // page size, so a smaller, budget-fitting `first` is just as valid a
      // proof and doesn't require loosening the real cost limit.
      for (let i = 0; i < 15; i++) {
        const { mediaId } = await db
          .transaction()
          .execute((tx) =>
            mediaRepo.upsert(
              tx,
              media({ igMediaId: `p${i}`, igTimestamp: new Date(Date.now() - i * 60000) }),
              clock
            )
          );
        await db
          .insertInto("media_assets")
          .values({
            media_id: mediaId,
            position: 0,
            kind: "image",
            status: "stored",
            storage_key: `sha256/aa/fake${i}.jpg`,
            content_type: "image/jpeg",
          } as any)
          .execute();

        if (i % 5 === 0) {
          const group = await db
            .insertInto("repost_groups")
            .values({ canonical_media_id: mediaId, size: 1 })
            .returning("id")
            .executeTakeFirstOrThrow();
          await db.updateTable("media").set({ repost_group_id: group.id }).where("id", "=", mediaId).execute();
        }
      }

      const key = await seedDashboardKey(db);
      const { db: countingReadDb, count } = makeCountingDb(connectionString);

      const app = createApp({
        db,
        readDb: countingReadDb,
        storage,
        cursorKeys,
        hashtag: "matcha",
      });

      const res = await graphqlRequest(
        app,
        key,
        `{
          posts(first: 15) {
            edges {
              node {
                id
                assets { position status url }
                repostGroup { id size }
              }
            }
          }
        }`
      );

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.posts.edges.length).toBe(15);
      // 1 query for the feed page itself (posts() reads through ctx.readDb,
      // which IS this counted pool) + 1 batched assetsByMediaId call for
      // all posts + 1 batched repostGroupById call for all posts = 3
      // total, regardless of how many posts are requested.
      expect(count()).toBeLessThanOrEqual(3);

      await countingReadDb.destroy();
    });
  });

  it("engagementHistory buckets match hand-computed buckets", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "eh1" }), clock));

      const run = await db
        .insertInto("sync_runs")
        .values({ hashtag_id: (await hashtagRepo.upsertOnce(db, "matcha", "1")).id, edge: "recent", status: "SUCCESS" })
        .returning("id")
        .executeTakeFirstOrThrow();

      await db
        .insertInto("engagement_snapshots")
        .values([
          { media_id: mediaId, captured_at: new Date("2026-09-27T08:00:00Z"), like_count: 1, comments_count: 0, sync_run_id: run.id },
          { media_id: mediaId, captured_at: new Date("2026-09-27T08:30:00Z"), like_count: 5, comments_count: 1, sync_run_id: run.id },
          { media_id: mediaId, captured_at: new Date("2026-09-27T09:15:00Z"), like_count: 9, comments_count: 2, sync_run_id: run.id },
        ] as any)
        .execute();

      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });

      const res = await graphqlRequest(
        app,
        key,
        `query($id: ID!) {
          post(id: $id) {
            engagementHistory(from: "2026-09-27T00:00:00Z", to: "2026-09-28T00:00:00Z", bucket: HOUR, first: 10) {
              at
              likeCount
              commentsCount
            }
          }
        }`,
        { id: String(mediaId) }
      );

      expect(res.status).toBe(200);
      const points = res.body.data.post.engagementHistory;
      // Hand-computed: hour bucket 08:00 has two snapshots (08:00, 08:30) —
      // the later one (08:30, likes=5) is representative; hour bucket 09:00
      // has one snapshot (09:15, likes=9).
      expect(points.length).toBe(2);
      expect(points[0].likeCount).toBe(5);
      expect(points[1].likeCount).toBe(9);
    });
  });

  it("repostGroup.members returns only that group's posts, paginated", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId: canonicalId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "canon" }), clock));
      const { mediaId: memberId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "member", igTimestamp: new Date("2026-09-27T09:30:00Z") }), clock));
      const { mediaId: outsiderId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "outsider" }), clock));

      const group = await db
        .insertInto("repost_groups")
        .values({ canonical_media_id: canonicalId, size: 2 })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("media")
        .set({ repost_group_id: group.id })
        .where("id", "in", [canonicalId, memberId])
        .execute();
      void outsiderId;

      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });

      const res = await graphqlRequest(
        app,
        key,
        `query($id: ID!) {
          repostGroup(id: $id) {
            size
            members(first: 10) { edges { node { igMediaId } } }
          }
        }`,
        { id: String(group.id) }
      );

      expect(res.status).toBe(200);
      const ids = res.body.data.repostGroup.members.edges.map((e: any) => e.node.igMediaId).sort();
      expect(ids).toEqual(["canon", "member"]);
    });
  });

  it("posts never returns a repost, matching GET /hashtags", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId: origId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "orig" }), clock));
      const { mediaId: repostId } = await db
        .transaction()
        .execute((tx) =>
          mediaRepo.upsert(tx, media({ igMediaId: "repost", igTimestamp: new Date("2026-09-27T09:30:00Z") }), clock)
        );
      await db
        .updateTable("media")
        .set({ duplicate_of_id: origId, dup_reason: "exact_bytes" })
        .where("id", "=", repostId)
        .execute();

      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "1");
      for (const id of [origId, repostId]) {
        await db
          .insertInto("media_hashtags")
          .values({ media_id: id, hashtag_id: hashtag.id, edges: ["recent"], first_seen_at: clock.now() } as any)
          .execute();
      }

      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });

      const gqlRes = await graphqlRequest(app, key, "{ posts(first: 10) { edges { node { igMediaId } } } }");
      const gqlIds = gqlRes.body.data.posts.edges.map((e: any) => e.node.igMediaId);
      expect(gqlIds).not.toContain("repost");

      const restRes = await request(app).get("/hashtags");
      const restIds = restRes.body.data.map((d: any) => d.igMediaId);
      expect(restIds).not.toContain("repost");
    });
  });

  it("a post's likeCount via GraphQL matches GET /hashtags for the same post", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "consist1", likeCount: 42 }), clock));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "1");
      await db
        .insertInto("media_hashtags")
        .values({ media_id: mediaId, hashtag_id: hashtag.id, edges: ["recent"], first_seen_at: clock.now() } as any)
        .execute();

      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });

      const gqlRes = await graphqlRequest(
        app,
        key,
        `query($id: ID!) { post(id: $id) { likeCount } }`,
        { id: String(mediaId) }
      );
      const restRes = await request(app).get("/hashtags");
      const restPost = restRes.body.data.find((d: any) => d.igMediaId === "consist1");

      expect(gqlRes.body.data.post.likeCount).toBe(42);
      expect(restPost.likeCount).toBe(42);
      expect(gqlRes.body.data.post.likeCount).toBe(restPost.likeCount);
    });
  });
});
