import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("outbox")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("payload", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("available_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("published_at", "timestamptz")
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .execute();

  await sql`
    CREATE INDEX outbox_pending_idx ON outbox (available_at)
    WHERE published_at IS NULL
  `.execute(db);

  await grantAppTable(db, "outbox");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("outbox").ifExists().execute();
}
