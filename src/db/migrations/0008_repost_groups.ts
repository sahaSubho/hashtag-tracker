import { sql, type Kysely } from "kysely";
import { grantAppTable, grantGraphqlTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("repost_groups")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("canonical_media_id", "bigint", (c) => c.notNull().references("media.id"))
    .addColumn("size", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("total_likes", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("total_comments", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // media.repost_group_id references this table; added here (not in the
  // media migration) because repost_groups did not exist yet at that point.
  await db.schema
    .alterTable("media")
    .addForeignKeyConstraint("media_repost_group_fk", ["repost_group_id"], "repost_groups", ["id"])
    .execute();

  await grantAppTable(db, "repost_groups");
  await grantGraphqlTable(db, "repost_groups");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("media").dropConstraint("media_repost_group_fk").execute();
  await db.schema.dropTable("repost_groups").ifExists().execute();
}
