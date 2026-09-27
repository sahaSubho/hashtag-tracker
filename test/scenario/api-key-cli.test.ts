import { describe, it, expect, vi } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock } from "../helpers/fakes.js";
import { createApiKeyCli, revokeApiKeyCli } from "../../src/cli/api-key-cli.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";

describe("api key CLI", () => {
  it("createApiKeyCli inserts a hashed row and returns the plaintext once", async () => {
    await withTestDb(async (db) => {
      const result = await createApiKeyCli(db, { name: "dashboard-prod", scopes: ["dashboard:read"] });
      expect(result.plaintext).toMatch(/^dash_/);

      const row = await apiKeyRepo.findByKeyId(db, result.keyId);
      expect(row?.name).toBe("dashboard-prod");
      expect(row?.hash).not.toBe(result.plaintext);
    });
  });

  it("revokeApiKeyCli marks the key revoked", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const created = await createApiKeyCli(db, { name: "x", scopes: [] }, clock);
      await revokeApiKeyCli(db, created.keyId, clock);

      const row = await apiKeyRepo.findByKeyId(db, created.keyId);
      expect(row?.revoked_at).not.toBeNull();
    });
  });
});
