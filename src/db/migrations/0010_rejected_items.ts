import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("rejected_items")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("sync_run_id", "uuid", (c) => c.notNull().references("sync_runs.id"))
    .addColumn("ig_media_id", "text")
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("payload_excerpt", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await grantAppTable(db, "rejected_items");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("rejected_items").ifExists().execute();
}
