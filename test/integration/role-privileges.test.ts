import { describe, it, expect } from "vitest";
import request from "supertest";
import { sql, type Kysely, type Transaction } from "kysely";
import { withTestDb, withAppRole, withGraphqlRole } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";
import { generateApiKey, hashApiKeySecret } from "../../src/domain/api-key.js";
import type { DB } from "../../src/db/schema.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

/**
 * Privileges exercised under the real roles (spec §5), not the test
 * superuser. Both failures here were first seen against a live run.
 */
describe("database role privileges", () => {
  it("tracker_app can use every sequence (inserts into serial-id tables)", async () => {
    await withTestDb(async (db) => {
      const { rows } = await sql<{ name: string }>`
        SELECT sequence_name AS name FROM information_schema.sequences WHERE sequence_schema = 'public'
      `.execute(db);
      expect(rows.length).toBeGreaterThan(0);

      await withAppRole(db, async (roleDb) => {
        for (const { name } of rows) {
          await sql`SELECT nextval(${name}::regclass)`.execute(roleDb);
        }
      });
    });
  });

  it("tracker_app can store a hashtag and a post with assets through the real repos", async () => {
    await withTestDb(async (db) => {
      await withAppRole(db, async (roleDb) => {
        const tx = roleDb as unknown as Transaction<DB>;
        await hashtagRepo.upsertOnce(roleDb, "matcha", "17843");
        const result = await mediaRepo.upsert(
          tx,
          {
            igMediaId: "m1",
            mediaType: "IMAGE",
            caption: null,
            captionNormHash: null,
            permalink: "p",
            igTimestamp: new Date("2026-09-27T08:00:00Z"),
            likeCount: 1,
            commentsCount: 0,
            assets: [{ position: 0, kind: "image", sourceUrl: "https://x.cdninstagram.com/a.jpg", sourceUrlExpiresAt: null }],
            raw: {},
          } as any,
          new FakeClock(new Date("2026-09-28T00:00:00Z"))
        );
        expect(result.isNew).toBe(true);
      });
    });
  });

  it("tracker_graphql can run a dashboard query touching every Post field", async () => {
    await withTestDb(async (db) => {
      const { plaintext, keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "t", scopes: ["dashboard:read"] });
      const [m] = await db
        .insertInto("media")
        .values({ ig_media_id: "m1", media_type: "IMAGE", permalink: "p", ig_timestamp: "2026-09-27T08:00:00Z" } as any)
        .returning("id")
        .execute();
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");
      await db.insertInto("media_hashtags").values({ media_id: m!.id, hashtag_id: hashtag.id, edges: ["recent"], first_seen_at: new Date() } as any).execute();
      await db.insertInto("media_assets").values({ media_id: m!.id, position: 0, kind: "image", status: "pending" } as any).execute();

      const res = await withGraphqlRole(db, (readDb) =>
        request(createApp({ db, readDb, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" }))
          .post("/graphql")
          .set("Authorization", `Bearer ${plaintext}`)
          .send({
            query: `{ posts(first: 5) { edges { node {
              igMediaId assets { kind status }
              engagementHistory(from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z", bucket: DAY, first: 10) { at }
              repostGroup { id size }
            } } } }`,
          })
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.posts.edges[0].node).toMatchObject({ igMediaId: "m1", assets: [{ kind: "image" }] });
    });
  });
});
