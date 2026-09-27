import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await db.schema
    .createTable("hashtags")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull().unique())
    .addColumn("ig_hashtag_id", "text", (c) => c.notNull().unique())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await grantAppTable(db, "hashtags");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("hashtags").ifExists().execute();
}
