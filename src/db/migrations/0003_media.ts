import { sql, type Kysely } from "kysely";
import { grantAppTable, grantGraphqlTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("media")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("ig_media_id", "text", (c) => c.notNull().unique())
    .addColumn("media_type", "text", (c) =>
      c.notNull().check(sql`media_type IN ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM')`)
    )
    .addColumn("caption", "text")
    .addColumn("caption_norm_hash", "text")
    .addColumn("permalink", "text", (c) => c.notNull())
    .addColumn("ig_timestamp", "timestamptz", (c) => c.notNull())
    .addColumn("like_count", "integer")
    .addColumn("comments_count", "integer")
    .addColumn("first_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("last_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("repost_group_id", "bigint")
    .addColumn("duplicate_of_id", "bigint")
    .addColumn("dup_reason", "text", (c) =>
      c.check(sql`dup_reason IS NULL OR dup_reason IN ('exact_bytes', 'caption')`)
    )
    .addColumn("raw", "jsonb")
    .addColumn("raw_expires_at", "timestamptz")
    .addForeignKeyConstraint(
      "media_duplicate_of_fk",
      ["duplicate_of_id"],
      "media",
      ["id"]
    )
    .execute();

  await sql`
    CREATE INDEX media_feed_idx ON media (ig_timestamp DESC, id DESC)
    WHERE duplicate_of_id IS NULL
  `.execute(db);

  await sql`
    CREATE INDEX media_caption_hash_idx ON media (caption_norm_hash)
    WHERE caption_norm_hash IS NOT NULL
  `.execute(db);

  await grantAppTable(db, "media");
  await grantGraphqlTable(db, "media");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("media").ifExists().execute();
}
