import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { InMemoryRateLimitStore } from "../../src/adapters/rate-limit/in-memory-rate-limit-store.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

describe("REST rate limiting", () => {
  it("returns 429 with Retry-After once the limit is exceeded", async () => {
    await withTestDb(async (db) => {
      await db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "17843" }).execute();
      const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
      const rateLimitStore = new InMemoryRateLimitStore(clock);
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        rateLimit: { store: rateLimitStore, limit: 2, windowMs: 60000, burst: 0 },
      });

      await request(app).get("/hashtags");
      await request(app).get("/hashtags");
      const third = await request(app).get("/hashtags");

      expect(third.status).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
    });
  });

  it("sets RateLimit-* headers on allowed responses", async () => {
    await withTestDb(async (db) => {
      await db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "17843" }).execute();
      const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
      const rateLimitStore = new InMemoryRateLimitStore(clock);
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        rateLimit: { store: rateLimitStore, limit: 5, windowMs: 60000, burst: 0 },
      });

      const res = await request(app).get("/hashtags");
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBe("5");
      expect(res.headers["ratelimit-remaining"]).toBeDefined();
    });
  });

  it("does not rate-limit when no rate limit config is supplied (opt-in)", async () => {
    await withTestDb(async (db) => {
      await db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "17843" }).execute();
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
      });
      for (let i = 0; i < 10; i++) {
        const res = await request(app).get("/hashtags");
        expect(res.status).toBe(200);
      }
    });
  });

  it("with trustProxy=0, cycling X-Forwarded-For does not bypass the limit", async () => {
    await withTestDb(async (db) => {
      await db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "17843" }).execute();
      const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
      const rateLimitStore = new InMemoryRateLimitStore(clock);
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        rateLimit: { store: rateLimitStore, limit: 1, windowMs: 60000, burst: 0 },
        trustProxy: 0,
      });

      await request(app).get("/hashtags").set("X-Forwarded-For", "1.1.1.1");
      const second = await request(app).get("/hashtags").set("X-Forwarded-For", "2.2.2.2");
      expect(second.status).toBe(429);
    });
  });
});
