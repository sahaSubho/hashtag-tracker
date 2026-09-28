import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Kysely } from "kysely";
import { withTestDb } from "../helpers/pg.js";
import { FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";
import { generateApiKey, hashApiKeySecret } from "../../src/domain/api-key.js";
import type { DB } from "../../src/db/schema.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

async function seedKey(db: Kysely<DB>, scopes: string[]): Promise<string> {
  const { plaintext, keyId, secret } = generateApiKey();
  await apiKeyRepo.create(db, { keyId, hash: hashApiKeySecret(secret), name: `test-${scopes.join("-")}`, scopes });
  return plaintext;
}

/**
 * The app as src/index.ts actually wires it: /internal/* AND /graphql both
 * enabled. Found while testing manually against the live app: the admin
 * gate was registered with a pathless router.use(), so it ran for every
 * request after it — a valid dashboard:read key got 403 on /graphql. Each
 * route group's tests enabled only its own routes, so none caught it.
 */
function fullApp(db: Kysely<DB>) {
  return createApp({
    db,
    readDb: db,
    storage: new FakeStorage(),
    cursorKeys,
    hashtag: "matcha",
    enableInternalRoutes: true,
  });
}

describe("route isolation with every route group enabled", () => {
  it("lets a dashboard:read key use /graphql (the admin gate must not apply there)", async () => {
    await withTestDb(async (db) => {
      const key = await seedKey(db, ["dashboard:read"]);

      const res = await request(fullApp(db))
        .post("/graphql")
        .set("Authorization", `Bearer ${key}`)
        .send({ query: "{ posts(first: 1) { edges { node { id } } } }" });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
    });
  });

  it("still rejects a dashboard:read key on /internal/status", async () => {
    await withTestDb(async (db) => {
      const key = await seedKey(db, ["dashboard:read"]);

      const res = await request(fullApp(db)).get("/internal/status").set("Authorization", `Bearer ${key}`);

      expect(res.status).toBe(403);
    });
  });

  it("returns 404, not 401, for an unknown path without a key", async () => {
    await withTestDb(async (db) => {
      const res = await request(fullApp(db)).get("/no-such-route");

      expect(res.status).toBe(404);
    });
  });
});
