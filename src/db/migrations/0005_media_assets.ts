import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("media_assets")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("media_id", "bigint", (c) =>
      c.notNull().references("media.id").onDelete("cascade")
    )
    .addColumn("position", "integer", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind IN ('image', 'video')`))
    .addColumn("source_url", "text")
    .addColumn("source_url_expires_at", "timestamptz")
    .addColumn("status", "text", (c) =>
      c
        .notNull()
        .check(
          sql`status IN ('pending', 'downloading', 'stored', 'url_expired', 'failed', 'no_url')`
        )
    )
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("lease_until", "timestamptz")
    .addColumn("content_sha256", "text")
    .addColumn("storage_key", "text")
    .addColumn("content_type", "text")
    .addColumn("bytes", "bigint")
    .addColumn("stored_at", "timestamptz")
    .addColumn("last_error", "text")
    .addUniqueConstraint("media_assets_media_position_uk", ["media_id", "position"])
    .execute();

  await sql`
    CREATE INDEX media_assets_expiry_idx ON media_assets (status, source_url_expires_at)
  `.execute(db);

  await sql`
    CREATE INDEX media_assets_content_sha256_idx ON media_assets (content_sha256)
    WHERE content_sha256 IS NOT NULL
  `.execute(db);

  await grantAppTable(db, "media_assets");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("media_assets").ifExists().execute();
}
