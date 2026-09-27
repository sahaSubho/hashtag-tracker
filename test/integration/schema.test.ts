import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";

describe("schema", () => {
  it("enforces the unique ig_media_id", async () => {
    await withTestDb(async (db) => {
      const base = {
        ig_media_id: "m1",
        media_type: "IMAGE",
        permalink: "p",
        ig_timestamp: new Date().toISOString(),
      };
      await db.insertInto("media").values(base as any).execute();
      await expect(
        db.insertInto("media").values(base as any).execute()
      ).rejects.toThrow();
    });
  });

  it("has the partial feed index excluding reposts", async () => {
    await withTestDb(async (db) => {
      const r = await db
        .selectFrom("pg_indexes" as any)
        .select("indexname" as any)
        .where("indexname" as any, "=", "media_feed_idx")
        .execute();
      expect(r.length).toBe(1);
    });
  });

  it("has the caption norm hash index", async () => {
    await withTestDb(async (db) => {
      const r = await db
        .selectFrom("pg_indexes" as any)
        .select("indexname" as any)
        .where("indexname" as any, "=", "media_caption_hash_idx")
        .execute();
      expect(r.length).toBe(1);
    });
  });

  it("rejects an unknown media_type via the check constraint", async () => {
    await withTestDb(async (db) => {
      await expect(
        db
          .insertInto("media")
          .values({
            ig_media_id: "m2",
            media_type: "STORY",
            permalink: "p",
            ig_timestamp: new Date().toISOString(),
          } as any)
          .execute()
      ).rejects.toThrow();
    });
  });

  it("creates media_assets with a unique (media_id, position) and a status check", async () => {
    await withTestDb(async (db) => {
      const media = await db
        .insertInto("media")
        .values({
          ig_media_id: "m3",
          media_type: "IMAGE",
          permalink: "p",
          ig_timestamp: new Date().toISOString(),
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow();

      await db
        .insertInto("media_assets")
        .values({ media_id: media.id, position: 0, kind: "image", status: "pending" } as any)
        .execute();

      await expect(
        db
          .insertInto("media_assets")
          .values({ media_id: media.id, position: 0, kind: "image", status: "pending" } as any)
          .execute()
      ).rejects.toThrow();

      await expect(
        db
          .insertInto("media_assets")
          .values({ media_id: media.id, position: 1, kind: "image", status: "bogus" } as any)
          .execute()
      ).rejects.toThrow();
    });
  });

  it("creates media_hashtags joining media and hashtags", async () => {
    await withTestDb(async (db) => {
      const hashtag = await db
        .insertInto("hashtags")
        .values({ name: "matcha", ig_hashtag_id: "1" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const media = await db
        .insertInto("media")
        .values({
          ig_media_id: "m4",
          media_type: "IMAGE",
          permalink: "p",
          ig_timestamp: new Date().toISOString(),
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow();

      await db
        .insertInto("media_hashtags")
        .values({ media_id: media.id, hashtag_id: hashtag.id, edges: ["recent"] } as any)
        .execute();

      const rows = await db.selectFrom("media_hashtags").selectAll().execute();
      expect(rows.length).toBe(1);
    });
  });

  it("creates sync_runs with a uuid default id and status check", async () => {
    await withTestDb(async (db) => {
      const hashtag = await db
        .insertInto("hashtags")
        .values({ name: "matcha", ig_hashtag_id: "1" })
        .returning("id")
        .executeTakeFirstOrThrow();

      const run = await db
        .insertInto("sync_runs")
        .values({
          hashtag_id: hashtag.id,
          edge: "recent",
          status: "RUNNING",
        } as any)
        .returning(["id", "status"])
        .executeTakeFirstOrThrow();

      expect(typeof run.id).toBe("string");
      expect(run.status).toBe("RUNNING");
    });
  });

  it("creates the outbox table with a partial index on pending rows", async () => {
    await withTestDb(async (db) => {
      const r = await db
        .selectFrom("pg_indexes" as any)
        .select("indexname" as any)
        .where("indexname" as any, "=", "outbox_pending_idx")
        .execute();
      expect(r.length).toBe(1);
    });
  });

  it("creates engagement_snapshots, repost_groups, rejected_items, dead_letters, alerts, api_keys", async () => {
    await withTestDb(async (db) => {
      const tables = await db
        .selectFrom("information_schema.tables" as any)
        .select("table_name" as any)
        .where("table_schema" as any, "=", "public")
        .execute();
      const names = tables.map((t: any) => t.table_name);
      for (const t of [
        "engagement_snapshots",
        "repost_groups",
        "rejected_items",
        "dead_letters",
        "alerts",
        "api_keys",
      ]) {
        expect(names).toContain(t);
      }
    });
  });

  it("grants tracker_graphql SELECT on media but not INSERT", async () => {
    await withTestDb(async (db) => {
      const privs = await db
        .selectFrom("information_schema.role_table_grants" as any)
        .select(["privilege_type" as any])
        .where("grantee" as any, "=", "tracker_graphql")
        .where("table_name" as any, "=", "media")
        .execute();
      const types = privs.map((p: any) => p.privilege_type);
      expect(types).toContain("SELECT");
      expect(types).not.toContain("INSERT");
    });
  });
});
