import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("alerts")
    .addColumn("alert_key", "text", (c) => c.primaryKey())
    .addColumn("state", "text", (c) => c.notNull().check(sql`state IN ('firing', 'resolved')`))
    .addColumn("fired_at", "timestamptz", (c) => c.notNull())
    .addColumn("resolved_at", "timestamptz")
    .addColumn("last_notified_at", "timestamptz")
    .addColumn("details", "jsonb")
    .execute();

  await grantAppTable(db, "alerts");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("alerts").ifExists().execute();
}
