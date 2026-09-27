import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("media_hashtags")
    .addColumn("media_id", "bigint", (c) =>
      c.notNull().references("media.id").onDelete("cascade")
    )
    .addColumn("hashtag_id", "bigint", (c) =>
      c.notNull().references("hashtags.id").onDelete("cascade")
    )
    .addColumn("edges", sql`text[]`, (c) => c.notNull())
    .addColumn("first_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("media_hashtags_pk", ["media_id", "hashtag_id"])
    .execute();

  await grantAppTable(db, "media_hashtags");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("media_hashtags").ifExists().execute();
}
