import { type Kysely } from "kysely";
import { grantAppTable, grantGraphqlTable } from "../grants.js";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("engagement_snapshots")
    .addColumn("media_id", "bigint", (c) =>
      c.notNull().references("media.id").onDelete("cascade")
    )
    .addColumn("captured_at", "timestamptz", (c) => c.notNull())
    .addColumn("like_count", "integer")
    .addColumn("comments_count", "integer")
    .addColumn("sync_run_id", "uuid", (c) => c.notNull().references("sync_runs.id"))
    .addPrimaryKeyConstraint("engagement_snapshots_pk", ["media_id", "captured_at"])
    .execute();

  await grantAppTable(db, "engagement_snapshots");
  await grantGraphqlTable(db, "engagement_snapshots");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("engagement_snapshots").ifExists().execute();
}
