import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock } from "../helpers/fakes.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";
import { generateApiKey, hashApiKeySecret } from "../../src/domain/api-key.js";

describe("apiKeyRepo", () => {
  it("creates and finds a key by keyId", async () => {
    await withTestDb(async (db) => {
      const { keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, {
        keyId,
        hash: hashApiKeySecret(secret),
        name: "dashboard-prod",
        scopes: ["dashboard:read"],
      });

      const row = await apiKeyRepo.findByKeyId(db, keyId);
      expect(row?.name).toBe("dashboard-prod");
      expect(row?.scopes).toEqual(["dashboard:read"]);
    });
  });

  it("returns undefined for an unknown keyId", async () => {
    await withTestDb(async (db) => {
      const row = await apiKeyRepo.findByKeyId(db, "unknown123");
      expect(row).toBeUndefined();
    });
  });

  it("revoke sets revoked_at", async () => {
    await withTestDb(async (db) => {
      const { keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "x", scopes: [] });
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await apiKeyRepo.revoke(db, keyId, clock.now());

      const row = await apiKeyRepo.findByKeyId(db, keyId);
      expect(row?.revoked_at).not.toBeNull();
    });
  });

  it("touchLastUsed updates last_used_at", async () => {
    await withTestDb(async (db) => {
      const { keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "x", scopes: [] });
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await apiKeyRepo.touchLastUsed(db, keyId, clock.now());

      const row = await apiKeyRepo.findByKeyId(db, keyId);
      expect(row?.last_used_at?.toISOString()).toBe("2026-09-27T09:00:00.000Z");
    });
  });
});
