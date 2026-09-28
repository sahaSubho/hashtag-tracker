import { sql, type Kysely } from "kysely";
import { grantAppSequences, grantGraphqlTable } from "../grants.js";

/**
 * Grants that migrations 0002–0014 missed, found against a live run (the
 * test suite connected as a superuser, which bypasses grants entirely):
 *
 * - tracker_app had table privileges but no USAGE on the bigserial
 *   sequences behind them, so the very first INSERT (hashtags) failed with
 *   "permission denied for sequence hashtags_id_seq".
 * - tracker_graphql could read media, engagement_snapshots and
 *   repost_groups, but not media_assets (Post.assets) or media_hashtags
 *   (the shared feed query), so dashboard queries failed.
 *
 * Grants only — additive and backward-compatible (spec §15 migration rule).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await grantAppSequences(db);
  await grantGraphqlTable(db, "media_assets");
  await grantGraphqlTable(db, "media_hashtags");
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE SELECT ON TABLE media_assets, media_hashtags FROM tracker_graphql`.execute(db);
  await sql`REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM tracker_app`.execute(db);
}
