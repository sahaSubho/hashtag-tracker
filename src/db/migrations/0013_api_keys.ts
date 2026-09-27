import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("api_keys")
    .addColumn("key_id", "text", (c) => c.primaryKey())
    .addColumn("hash", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("scopes", sql`text[]`, (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz")
    .addColumn("last_used_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .execute();

  await grantAppTable(db, "api_keys");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("api_keys").ifExists().execute();
}
