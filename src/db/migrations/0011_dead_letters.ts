import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("dead_letters")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("job_kind", "text", (c) => c.notNull())
    .addColumn("payload", "jsonb", (c) => c.notNull())
    .addColumn("attempts", "integer", (c) => c.notNull())
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await grantAppTable(db, "dead_letters");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("dead_letters").ifExists().execute();
}
