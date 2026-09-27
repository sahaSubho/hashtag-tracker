import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import type { MappedMedia } from "../../src/domain/types.js";

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

describe("DELETE /internal/media/:igMediaId", () => {
  it("401s without the admin token", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        adminToken: "secret-admin-token",
      });
      const res = await request(app).delete("/internal/media/m1");
      expect(res.status).toBe(401);
    });
  });

  it("deletes an existing post with the correct admin token", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "to-delete" }), clock));

      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        adminToken: "secret-admin-token",
      });
      const res = await request(app)
        .delete("/internal/media/to-delete")
        .set("Authorization", "Bearer secret-admin-token");

      expect(res.status).toBe(200);
      const row = await db.selectFrom("media").selectAll().where("ig_media_id", "=", "to-delete").executeTakeFirst();
      expect(row).toBeUndefined();
    });
  });

  it("returns 404 for an unknown ig_media_id", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        adminToken: "secret-admin-token",
      });
      const res = await request(app)
        .delete("/internal/media/nope")
        .set("Authorization", "Bearer secret-admin-token");
      expect(res.status).toBe(404);
    });
  });
});
