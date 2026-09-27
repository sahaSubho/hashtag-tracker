import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import { outboxRepo } from "../../src/db/repositories/outbox-repo.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";
import { generateApiKey, hashApiKeySecret } from "../../src/domain/api-key.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

async function seedAdminKey(db: any, scopes: string[] = ["admin"]) {
  const { plaintext, keyId, secret } = generateApiKey();
  await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "test-admin", scopes });
  return plaintext;
}

describe("GET /internal/status", () => {
  it("401s without an API key", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        enableInternalRoutes: true,
      });
      const res = await request(app).get("/internal/status");
      expect(res.status).toBe(401);
    });
  });

  it("401s with a malformed key", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        enableInternalRoutes: true,
      });
      const res = await request(app).get("/internal/status").set("Authorization", "Bearer wrong");
      expect(res.status).toBe(401);
    });
  });

  it("403s with a valid key that lacks the admin scope", async () => {
    await withTestDb(async (db) => {
      const key = await seedAdminKey(db, ["dashboard:read"]);
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        enableInternalRoutes: true,
      });
      const res = await request(app).get("/internal/status").set("Authorization", `Bearer ${key}`);
      expect(res.status).toBe(403);
    });
  });

  it("returns a status summary with a valid admin-scoped key", async () => {
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

      const key = await seedAdminKey(db);
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        enableInternalRoutes: true,
      });
      const res = await request(app).get("/internal/status").set("Authorization", `Bearer ${key}`);

      expect(res.status).toBe(200);
      expect(res.body.lastRuns).toBeDefined();
      expect(res.body.outboxBacklog).toBeGreaterThanOrEqual(1);
    });
  });

  it("when internal routes are not enabled, the endpoint is disabled (404)", async () => {
    await withTestDb(async (db) => {
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await request(app).get("/internal/status");
      expect(res.status).toBe(404);
    });
  });
});
