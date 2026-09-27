import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import request from "supertest";

describe("wiring", () => {
  it("createApp with fakes boots and /hashtags responds 200 with an empty feed for an untracked-but-then-tracked hashtag", async () => {
    await withTestDb(async (db) => {
      await db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "17843" }).execute();
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys: [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
        hashtag: "matcha",
      });

      const res = await request(app).get("/hashtags");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pageInfo.hasMore).toBe(false);
    });
  });

  it("responds to /healthz", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys: [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
        hashtag: "matcha",
      });
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
    });
  });
});
