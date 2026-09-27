import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import { outboxRepo } from "../../src/db/repositories/outbox-repo.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

describe("GET /internal/status", () => {
  it("401s without the admin token", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        adminToken: "secret-admin-token",
      });
      const res = await request(app).get("/internal/status");
      expect(res.status).toBe(401);
    });
  });

  it("401s with the wrong admin token", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        adminToken: "secret-admin-token",
      });
      const res = await request(app).get("/internal/status").set("Authorization", "Bearer wrong");
      expect(res.status).toBe(401);
    });
  });

  it("returns a status summary with the correct admin token", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");
      const run = await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));
      await db
        .transaction()
        .execute((tx) => syncRunRepo.finish(tx, run.id, { status: "SUCCESS", newestSeenTs: null, oldestSeenTs: null }));
      await db
        .transaction()
        .execute((tx) => outboxRepo.enqueue(tx, "DOWNLOAD_ASSET", { assetId: 1 }, clock.now()));

      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        adminToken: "secret-admin-token",
      });
      const res = await request(app)
        .get("/internal/status")
        .set("Authorization", "Bearer secret-admin-token");

      expect(res.status).toBe(200);
      expect(res.body.lastRuns).toBeDefined();
      expect(res.body.outboxBacklog).toBeGreaterThanOrEqual(1);
    });
  });

  it("when no adminToken is configured, the endpoint is disabled (404)", async () => {
    await withTestDb(async (db) => {
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/internal/status");
      expect(res.status).toBe(404);
    });
  });
});
