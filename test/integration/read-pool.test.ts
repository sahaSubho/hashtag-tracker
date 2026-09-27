import { describe, it, expect } from "vitest";
import { withTestDb, withGraphqlRole } from "../helpers/pg.js";
import { makeDb } from "../../src/db/pool.js";

describe("read pool / tracker_graphql isolation", () => {
  it("an INSERT under tracker_graphql is rejected with permission denied", async () => {
    await withTestDb(async (db) => {
      await expect(
        withGraphqlRole(db, (roleDb) =>
          roleDb.insertInto("hashtags").values({ name: "x", ig_hashtag_id: "1" }).execute()
        )
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("a SELECT under tracker_graphql succeeds on a table it's granted (media)", async () => {
    await withTestDb(async (db) => {
      await db
        .insertInto("media")
        .values({
          ig_media_id: "m1",
          media_type: "IMAGE",
          permalink: "p",
          ig_timestamp: new Date().toISOString(),
        } as any)
        .execute();

      const rows = await withGraphqlRole(db, (roleDb) =>
        roleDb.selectFrom("media").selectAll().execute()
      );
      expect(rows.length).toBe(1);
    });
  });

  it("a busy ingestion connection does not block a concurrent ReadDb query", async () => {
    await withTestDb(async (_db, connectionString) => {
      const ingestionDb = makeDb(connectionString); // pool with 1 logical "slot" under test
      const readDb = makeDb(connectionString); // a separate pool entirely

      try {
        // Hold the ingestion pool's connection inside an open transaction.
        const holdRelease = new Promise<void>((resolveHold) => {
          void ingestionDb.transaction().execute(async (tx) => {
            await tx.selectFrom("hashtags").selectAll().execute();
            await new Promise((r) => setTimeout(r, 300));
            resolveHold();
          });
        });

        // A query against the separate ReadDb pool must not be blocked by it.
        const start = Date.now();
        await readDb.selectFrom("hashtags").selectAll().execute();
        const elapsed = Date.now() - start;

        await holdRelease;
        expect(elapsed).toBeLessThan(250); // didn't wait for the 300ms hold to release
      } finally {
        await ingestionDb.destroy();
        await readDb.destroy();
      }
    });
  });
});
