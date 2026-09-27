import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

/**
 * Tracks the last check-in time of periodic background components (relay,
 * sweeper), so /readyz can detect a stalled process without relying on
 * metrics (spec §12.3: "relay and sweeper checked in within the last 2
 * minutes").
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("heartbeats")
    .addColumn("component", "text", (c) => c.primaryKey())
    .addColumn("last_seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await grantAppTable(db, "heartbeats");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("heartbeats").ifExists().execute();
}
