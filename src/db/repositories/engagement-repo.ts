import { sql, type Kysely } from "kysely";
import type { DB } from "../schema.js";

export type EngagementBucket = "HOUR" | "DAY";

export interface EngagementPoint {
  at: Date;
  likeCount: number | null;
  commentsCount: number | null;
}

const BUCKET_SQL: Record<EngagementBucket, "hour" | "day"> = {
  HOUR: "hour",
  DAY: "day",
};

export const engagementRepo = {
  /**
   * Buckets a post's engagement_snapshots into hourly or daily points
   * (spec §10, `Post.engagementHistory`). One point per bucket, taking the
   * last (max captured_at) snapshot in that bucket as representative —
   * engagement only grows across a bucket, so max(captured_at)'s values
   * are also the max counts, but we select by captured_at explicitly
   * rather than assume that, so a future backfill or correction doesn't
   * silently produce a wrong "max of two unrelated snapshots" number.
   */
  async bucketed(
    db: Kysely<DB>,
    mediaId: number,
    from: Date,
    to: Date,
    bucket: EngagementBucket,
    first: number
  ): Promise<EngagementPoint[]> {
    const truncUnit = BUCKET_SQL[bucket];

    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("engagement_snapshots")
          .select([
            sql<Date>`date_trunc(${sql.lit(truncUnit)}, captured_at)`.as("bucket_at"),
            "captured_at",
            "like_count",
            "comments_count",
          ])
          .where("media_id", "=", mediaId)
          .where("captured_at", ">=", from)
          .where("captured_at", "<=", to)
          .as("s")
      )
      .selectAll()
      .distinctOn("bucket_at")
      .orderBy("bucket_at", "desc")
      .orderBy("captured_at", "desc")
      .limit(first)
      .execute();

    return rows
      .map((r) => ({
        at: r.bucket_at,
        likeCount: r.like_count,
        commentsCount: r.comments_count,
      }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  },
};
