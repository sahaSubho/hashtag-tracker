import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";

describe("migrations", () => {
  it("creates the hashtags table with a unique name", async () => {
    await withTestDb(async (db) => {
      await db
        .insertInto("hashtags")
        .values({ name: "matcha", ig_hashtag_id: "1" })
        .execute();
      await expect(
        db
          .insertInto("hashtags")
          .values({ name: "matcha", ig_hashtag_id: "2" })
          .execute()
      ).rejects.toThrow();
    });
  });

  it("creates the tracker_app role without schema privileges", async () => {
    await withTestDb(async (db) => {
      const rows = await db
        .selectFrom("pg_roles" as any)
        .select("rolname" as any)
        .where("rolname" as any, "=", "tracker_app")
        .execute();
      expect(rows.length).toBe(1);
    });
  });

  it("creates the tracker_migrator and tracker_graphql roles", async () => {
    await withTestDb(async (db) => {
      const rows = await db
        .selectFrom("pg_roles" as any)
        .select("rolname" as any)
        .where("rolname" as any, "in", ["tracker_migrator", "tracker_graphql"])
        .execute();
      expect(rows.length).toBe(2);
    });
  });
});
