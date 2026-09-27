import { sql, type Kysely } from "kysely";
import { grantAppTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sync_runs")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("hashtag_id", "bigint", (c) => c.notNull().references("hashtags.id"))
    .addColumn("edge", "text", (c) => c.notNull().check(sql`edge IN ('top', 'recent')`))
    .addColumn("parent_run_id", "uuid")
    .addColumn("status", "text", (c) =>
      c.notNull().check(sql`status IN ('RUNNING', 'SUCCESS', 'TRUNCATED', 'FAILED')`)
    )
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .addColumn("pages", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("items_fetched", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("items_new", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("items_rejected", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("watermark_before", "timestamptz")
    .addColumn("newest_seen_ts", "timestamptz")
    .addColumn("oldest_seen_ts", "timestamptz")
    .addColumn("resume_cursor", "text")
    .addColumn("gap_status", "text", (c) =>
      c
        .notNull()
        .defaultTo("none")
        .check(sql`gap_status IN ('none', 'open', 'closed', 'unrecoverable')`)
    )
    .addColumn("error_code", "text")
    .addColumn("error_message", "text")
    .addForeignKeyConstraint("sync_runs_parent_fk", ["parent_run_id"], "sync_runs", ["id"])
    .execute();

  await sql`
    CREATE INDEX sync_runs_hashtag_edge_idx ON sync_runs (hashtag_id, edge, started_at DESC)
  `.execute(db);

  await grantAppTable(db, "sync_runs");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sync_runs").ifExists().execute();
}
