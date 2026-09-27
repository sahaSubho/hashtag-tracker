import type { Kysely, Transaction } from "kysely";
import type { DB } from "../schema.js";
import type { Clock } from "../../ports/clock.js";
import type { MappedMedia } from "../../domain/types.js";

export interface UpsertMediaResult {
  mediaId: number;
  isNew: boolean;
  countsChanged: boolean;
}

const RAW_RETENTION_DAYS_DEFAULT = 30;

export const mediaRepo = {
  /**
   * Upserts one post on ig_media_id: on first sight inserts a new row; on
   * a repeat sight refreshes like/comment counts and last_seen_at while
   * preserving first_seen_at. Returns whether the row was new and whether
   * engagement counts changed (used by the caller to decide whether to
   * write an engagement_snapshots row).
   */
  async upsert(
    tx: Transaction<DB>,
    m: MappedMedia,
    clock: Clock,
    rawRetentionDays: number = RAW_RETENTION_DAYS_DEFAULT
  ): Promise<UpsertMediaResult> {
    const now = clock.now();
    const rawExpiresAt = new Date(now.getTime() + rawRetentionDays * 24 * 60 * 60 * 1000);

    const existing = await tx
      .selectFrom("media")
      .select(["id", "like_count", "comments_count"])
      .where("ig_media_id", "=", m.igMediaId)
      .executeTakeFirst();

    if (!existing) {
      const inserted = await tx
        .insertInto("media")
        .values({
          ig_media_id: m.igMediaId,
          media_type: m.mediaType,
          caption: m.caption,
          caption_norm_hash: m.captionNormHash,
          permalink: m.permalink,
          ig_timestamp: m.igTimestamp,
          like_count: m.likeCount,
          comments_count: m.commentsCount,
          first_seen_at: now.toISOString(),
          last_seen_at: now.toISOString(),
          raw: JSON.stringify(m.raw ?? {}),
          raw_expires_at: rawExpiresAt,
        })
        .onConflict((oc) =>
          oc.column("ig_media_id").doUpdateSet((eb) => ({
            like_count: eb.ref("excluded.like_count"),
            comments_count: eb.ref("excluded.comments_count"),
            last_seen_at: eb.ref("excluded.last_seen_at"),
          }))
        )
        .returning(["id", "like_count", "comments_count"])
        .executeTakeFirstOrThrow();

      return { mediaId: inserted.id, isNew: true, countsChanged: true };
    }

    const countsChanged =
      existing.like_count !== (m.likeCount ?? null) ||
      existing.comments_count !== (m.commentsCount ?? null);

    await tx
      .updateTable("media")
      .set({
        like_count: m.likeCount,
        comments_count: m.commentsCount,
        last_seen_at: now.toISOString(),
        caption: m.caption,
        caption_norm_hash: m.captionNormHash,
        raw: JSON.stringify(m.raw ?? {}),
        raw_expires_at: rawExpiresAt,
      })
      .where("id", "=", existing.id)
      .execute();

    return { mediaId: existing.id, isNew: false, countsChanged };
  },

  async findById(db: Kysely<DB>, id: number) {
    return db.selectFrom("media").selectAll().where("id", "=", id).executeTakeFirst();
  },
};
