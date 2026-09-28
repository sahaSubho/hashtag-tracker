import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { makeCountingDb } from "../helpers/query-counter.js";
import { createApp } from "../../src/http/app.js";
import { apiKeyRepo } from "../../src/db/repositories/api-key-repo.js";
import { generateApiKey, hashApiKeySecret } from "../../src/domain/api-key.js";
import { ResponseCache } from "../../src/graphql/response-cache.js";
import { InMemoryRateLimitStore } from "../../src/adapters/rate-limit/in-memory-rate-limit-store.js";
import { registerOperation } from "../../src/graphql/persisted-operations.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

async function seedDashboardKey(db: any) {
  const { plaintext, keyId, secret } = generateApiKey();
  await apiKeyRepo.create(db, {
    keyId,
    hash: hashApiKeySecret(secret),
    name: "test-dashboard",
    scopes: ["dashboard:read"],
  });
  return plaintext;
}

async function gql(app: ReturnType<typeof createApp>, key: string, query: string, variables?: unknown) {
  return request(app).post("/graphql").set("Authorization", `Bearer ${key}`).send({ query, variables });
}

const SIMPLE_QUERY = "{ posts(first: 1) { edges { node { id } } } }";

describe("GraphQL limits, allowlist, cache, cost-rate-limit (P3-04)", () => {
  it("a query outside the persisted-operation allowlist is rejected in production mode", async () => {
    await withTestDb(async (db) => {
      const key = await seedDashboardKey(db);
      const app = createApp({
        db,
        readDb: db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlNodeEnv: "production",
      });
      const res = await gql(app, key, "{ posts(first: 1) { pageInfo { hasNextPage } } }");
      expect(res.body.errors?.[0]?.extensions?.code).toBe("OPERATION_NOT_ALLOWED");
    });
  });

  it("a registered operation is allowed in production mode", async () => {
    await withTestDb(async (db) => {
      registerOperation(SIMPLE_QUERY);
      const key = await seedDashboardKey(db);
      const app = createApp({
        db,
        readDb: db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlNodeEnv: "production",
      });
      const res = await gql(app, key, SIMPLE_QUERY);
      expect(res.body.errors).toBeUndefined();
    });
  });

  it("the same query is allowed outside production without registering it", async () => {
    await withTestDb(async (db) => {
      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await gql(app, key, "{ posts(first: 1) { pageInfo { endCursor } } }");
      expect(res.body.errors).toBeUndefined();
    });
  });

  it("a query nested past the depth limit (5) is rejected", async () => {
    await withTestDb(async (db) => {
      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const res = await gql(
        app,
        key,
        `{ posts(first: 1) { edges { node { repostGroup { canonical { repostGroup { id } } } } } } }`
      );
      expect(res.status).toBe(200);
      expect(res.body.errors?.[0]?.message).toMatch(/depth/i);
    });
  });

  it("11 aliases on one field is rejected", async () => {
    await withTestDb(async (db) => {
      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const aliases = Array.from({ length: 11 }, (_, i) => `a${i}: posts(first: 1) { pageInfo { hasNextPage } }`).join(
        "\n"
      );
      const res = await gql(app, key, `{ ${aliases} }`);
      expect(res.body.errors?.[0]?.message).toMatch(/alias/i);
    });
  });

  it("a query over cost 1000 is rejected before any SQL runs", async () => {
    await withTestDb(async (db, connectionString) => {
      const key = await seedDashboardKey(db);
      const { db: countingReadDb, count } = makeCountingDb(connectionString);
      const app = createApp({ db, readDb: countingReadDb, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });

      const res = await gql(
        app,
        key,
        `{
          posts(first: 50) {
            edges { node { id assets { position status url } repostGroup { id size } } }
          }
        }`
      );

      expect(res.body.errors?.[0]?.message).toMatch(/cost/i);
      expect(count()).toBe(0);
      await countingReadDb.destroy();
    });
  });

  it("first over 50 is rejected, not silently clamped", async () => {
    await withTestDb(async (db) => {
      const key = await seedDashboardKey(db);
      const app = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      // 60, not 500: at first:500 even this minimal selection set already
      // exceeds graphql-armor's separate cost limit (maxCost 1000), which
      // runs before this app's own first-cap check and would reject the
      // query for a different reason first. 60 is over the 50 cap but
      // still under the cost ceiling, so this test isolates and proves
      // specifically the FIRST_TOO_LARGE rule, not armor's cost rule.
      const res = await gql(app, key, "{ posts(first: 60) { pageInfo { hasNextPage } } }");
      expect(res.body.data).toBeUndefined(); // no data key at all — a GraphQL error response, not a clamped/partial result
      expect(res.body.errors?.[0]?.extensions?.code).toBe("FIRST_TOO_LARGE");
    });
  });

  it("a repeated identical query+variables+key within 30s runs 0 SQL statements; a different key runs one", async () => {
    await withTestDb(async (db, connectionString) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const cache = new ResponseCache(() => clock.now().getTime());
      const keyA = await seedDashboardKey(db);
      const keyB = await seedDashboardKey(db);
      const { db: countingReadDb, count } = makeCountingDb(connectionString);
      const app = createApp({
        db,
        readDb: countingReadDb,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlResponseCache: cache,
      });

      await gql(app, keyA, SIMPLE_QUERY);
      const countAfterFirst = count();
      expect(countAfterFirst).toBeGreaterThan(0);

      await gql(app, keyA, SIMPLE_QUERY);
      expect(count()).toBe(countAfterFirst); // no new SQL — served from cache

      await gql(app, keyB, SIMPLE_QUERY);
      expect(count()).toBeGreaterThan(countAfterFirst); // different key, cache miss

      await countingReadDb.destroy();
    });
  });

  it("a finished sync run clears the cache (a repeated query re-executes SQL)", async () => {
    await withTestDb(async (db, connectionString) => {
      const key = await seedDashboardKey(db);
      const cache = new ResponseCache();
      const { db: countingReadDb, count } = makeCountingDb(connectionString);
      const app = createApp({
        db,
        readDb: countingReadDb,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlResponseCache: cache,
      });

      await gql(app, key, SIMPLE_QUERY);
      const countAfterFirst = count();

      cache.clear(); // what index.ts's onSyncFinished hook does
      await gql(app, key, SIMPLE_QUERY);
      expect(count()).toBeGreaterThan(countAfterFirst);

      await countingReadDb.destroy();
    });
  });

  it("a key over its cost budget is rejected with RATE_LIMITED", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const store = new InMemoryRateLimitStore(clock);
      const key = await seedDashboardKey(db);
      const app = createApp({
        db,
        readDb: db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlRateLimitStore: store,
        graphqlCostPerMin: 1, // a budget of 1 point: this query's real
        // armor-computed cost is well above that, so even the first call
        // is over budget — the smallest possible reproduction of "the
        // budget is enforced at all", without needing to know that exact
        // cost number up front.
      });

      const res = await gql(app, key, SIMPLE_QUERY);
      expect(res.body.errors?.[0]?.extensions?.code).toBe("RATE_LIMITED");
    });
  });

  it("a key well under its cost budget is not rate limited", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const store = new InMemoryRateLimitStore(clock);
      const key = await seedDashboardKey(db);
      const app = createApp({
        db,
        readDb: db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlRateLimitStore: store,
        graphqlCostPerMin: 10_000, // spec §17 default — generous enough for one small query
      });

      const res = await gql(app, key, SIMPLE_QUERY);
      expect(res.body.errors).toBeUndefined();
    });
  });

  it("introspection (__schema) is rejected in production, allowed in dev", async () => {
    await withTestDb(async (db) => {
      const key = await seedDashboardKey(db);
      const prodApp = createApp({
        db,
        readDb: db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlNodeEnv: "production",
      });
      const prodRes = await gql(prodApp, key, "{ __schema { queryType { name } } }");
      expect(prodRes.body.errors?.[0]?.extensions?.code).toBe("INTROSPECTION_DISABLED");

      const devApp = createApp({ db, readDb: db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha" });
      const devRes = await gql(devApp, key, "{ __schema { queryType { name } } }");
      expect(devRes.body.errors).toBeUndefined();
    });
  });

  it("a thrown resolver error in production returns a generic message, not the real one", async () => {
    await withTestDb(async (db) => {
      const key = await seedDashboardKey(db);
      const app = createApp({
        db,
        readDb: db,
        storage: new FakeStorage(),
        cursorKeys,
        hashtag: "matcha",
        graphqlNodeEnv: "production",
      });
      registerOperation('{ repostGroup(id: "999999999") { canonical { id } } }');
      // repostGroup(id: 999999999) resolves to a group with no such
      // canonical media row — Post.canonical's resolver throws a specific
      // "canonical media N not found" error; production must mask it.
      const res = await gql(app, key, '{ repostGroup(id: "999999999") { canonical { id } } }');
      const message = res.body.errors?.[0]?.message ?? "";
      expect(message).not.toMatch(/not found/i);
    });
  });
});
