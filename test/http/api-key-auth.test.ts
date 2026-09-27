import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock } from "../helpers/fakes.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";
import { generateApiKey, hashApiKeySecret } from "../../src/domain/api-key.js";
import { authenticateApiKey } from "../../src/http/api-key-auth.js";

describe("authenticateApiKey", () => {
  it("authenticates a valid key with the right scope", async () => {
    await withTestDb(async (db) => {
      const { plaintext, keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, {
        keyId,
        hash: hashApiKeySecret(secret),
        name: "x",
        scopes: ["dashboard:read"],
      });
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));

      const result = await authenticateApiKey(db, clock, plaintext, "dashboard:read");
      expect(result.ok).toBe(true);
    });
  });

  it("rejects a wrong secret with a real keyId", async () => {
    await withTestDb(async (db) => {
      const { keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "x", scopes: ["dashboard:read"] });
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));

      const forged = `dash_${keyId}_${"A".repeat(43)}`;
      const result = await authenticateApiKey(db, clock, forged, "dashboard:read");
      expect(result.ok).toBe(false);
    });
  });

  it("rejects an unknown keyId, taking the same code path as a wrong secret", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { plaintext } = generateApiKey(); // never created in the db
      const result = await authenticateApiKey(db, clock, plaintext, "dashboard:read");
      expect(result.ok).toBe(false);
    });
  });

  it("rejects a revoked key", async () => {
    await withTestDb(async (db) => {
      const { plaintext, keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "x", scopes: ["dashboard:read"] });
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await apiKeyRepo.revoke(db, keyId, clock.now());

      const result = await authenticateApiKey(db, clock, plaintext, "dashboard:read");
      expect(result.ok).toBe(false);
    });
  });

  it("rejects an expired key", async () => {
    await withTestDb(async (db) => {
      const { plaintext, keyId, secret } = generateApiKey();
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await apiKeyRepo.create(db, {
        keyId,
        hash: hashApiKeySecret(secret),
        name: "x",
        scopes: ["dashboard:read"],
        expiresAt: new Date(clock.now().getTime() - 1000),
      });

      const result = await authenticateApiKey(db, clock, plaintext, "dashboard:read");
      expect(result.ok).toBe(false);
    });
  });

  it("rejects a key missing the required scope", async () => {
    await withTestDb(async (db) => {
      const { plaintext, keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "x", scopes: ["dashboard:read"] });
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));

      const result = await authenticateApiKey(db, clock, plaintext, "admin");
      expect(result.ok).toBe(false);
    });
  });

  it("updates last_used_at on success, at most once per minute", async () => {
    await withTestDb(async (db) => {
      const { plaintext, keyId, secret } = generateApiKey();
      await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: "x", scopes: ["dashboard:read"] });
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));

      await authenticateApiKey(db, clock, plaintext, "dashboard:read");
      const row1 = await apiKeyRepo.findByKeyId(db, keyId);
      expect(row1?.last_used_at).not.toBeNull();

      clock.advance(1000); // 1s later — inside the 1-minute throttle window
      await authenticateApiKey(db, clock, plaintext, "dashboard:read");
      const row2 = await apiKeyRepo.findByKeyId(db, keyId);
      expect(row2?.last_used_at?.toISOString()).toBe(row1?.last_used_at?.toISOString()); // unchanged
    });
  });
});
