import type { Transaction } from "kysely";
import type { DB } from "../db/schema.js";
import type { Metrics } from "../ports/metrics.js";

/**
 * Links a newly-stored primary asset's post to any existing repost group,
 * by exact file bytes first, then by normalized caption (spec §6.5).
 * Called inside the same transaction that marks the primary (position 0)
 * asset stored. For a post with no downloadable asset, the caller may
 * invoke this directly with contentSha256 = null to still attempt a
 * caption-only match.
 */
export async function linkReposts(
  tx: Transaction<DB>,
  mediaId: number,
  contentSha256: string | null,
  metrics?: Metrics
): Promise<void> {
  const post = await tx
    .selectFrom("media")
    .selectAll()
    .where("id", "=", mediaId)
    .executeTakeFirstOrThrow();

  // Already linked (e.g. a repeated sync re-triggering this) — nothing to do.
  if (post.duplicate_of_id !== null || post.repost_group_id !== null) {
    return;
  }

  let match: { id: number; ig_timestamp: Date; repost_group_id: number | null } | null = null;
  let reason: "exact_bytes" | "caption" | null = null;

  if (contentSha256) {
    const row = await tx
      .selectFrom("media")
      .innerJoin("media_assets", "media_assets.media_id", "media.id")
      .select(["media.id", "media.ig_timestamp", "media.repost_group_id"])
      .where("media_assets.position", "=", 0)
      .where("media_assets.content_sha256", "=", contentSha256)
      .where("media.id", "!=", mediaId)
      .where("media.duplicate_of_id", "is", null)
      .orderBy("media.ig_timestamp", "asc")
      .limit(1)
      .executeTakeFirst();
    if (row) {
      match = row;
      reason = "exact_bytes";
    }
  }

  if (!match && post.caption_norm_hash) {
    const row = await tx
      .selectFrom("media")
      .select(["id", "ig_timestamp", "repost_group_id"])
      .where("caption_norm_hash", "=", post.caption_norm_hash)
      .where("media_type", "=", post.media_type)
      .where("id", "!=", mediaId)
      .where("duplicate_of_id", "is", null)
      .orderBy("ig_timestamp", "asc")
      .limit(1)
      .executeTakeFirst();
    if (row) {
      match = row;
      reason = "caption";
    }
  }

  if (!match || !reason) {
    return;
  }

  const groupId = match.repost_group_id ?? (await createGroup(tx, match.id));

  // If the new post predates the current canonical, it becomes canonical:
  // demote the old canonical to a duplicate of the new one.
  if (post.ig_timestamp < match.ig_timestamp) {
    await tx
      .updateTable("repost_groups")
      .set({ canonical_media_id: mediaId })
      .where("id", "=", groupId)
      .execute();
    await tx
      .updateTable("media")
      .set({ duplicate_of_id: mediaId, dup_reason: reason, repost_group_id: groupId })
      .where("id", "=", match.id)
      .execute();
    await tx
      .updateTable("media")
      .set({ duplicate_of_id: null, dup_reason: null, repost_group_id: groupId })
      .where("id", "=", mediaId)
      .execute();
  } else {
    await tx
      .updateTable("media")
      .set({ duplicate_of_id: match.id, dup_reason: reason, repost_group_id: groupId })
      .where("id", "=", mediaId)
      .execute();
  }

  await recomputeGroupTotals(tx, groupId);
  metrics?.inc("repost.linked_total", { reason });
}

async function createGroup(tx: Transaction<DB>, canonicalMediaId: number): Promise<number> {
  const group = await tx
    .insertInto("repost_groups")
    .values({ canonical_media_id: canonicalMediaId, size: 1 })
    .returning("id")
    .executeTakeFirstOrThrow();

  await tx
    .updateTable("media")
    .set({ repost_group_id: group.id })
    .where("id", "=", canonicalMediaId)
    .execute();

  return group.id;
}

async function recomputeGroupTotals(tx: Transaction<DB>, groupId: number): Promise<void> {
  const members = await tx
    .selectFrom("media")
    .select(["like_count", "comments_count"])
    .where("repost_group_id", "=", groupId)
    .execute();

  const totalLikes = members.reduce((n, m) => n + (m.like_count ?? 0), 0);
  const totalComments = members.reduce((n, m) => n + (m.comments_count ?? 0), 0);

  await tx
    .updateTable("repost_groups")
    .set({
      size: members.length,
      total_likes: totalLikes,
      total_comments: totalComments,
      updated_at: new Date(),
    })
    .where("id", "=", groupId)
    .execute();
}

/**
 * Re-syncs a repost group's totals for whichever group `mediaId` belongs to
 * (if any). Called after an engagement-count update on an already-linked
 * post, so group totals stay correct without re-running link detection.
 */
export async function refreshGroupTotalsForMedia(tx: Transaction<DB>, mediaId: number): Promise<void> {
  const row = await tx
    .selectFrom("media")
    .select("repost_group_id")
    .where("id", "=", mediaId)
    .executeTakeFirst();
  if (row?.repost_group_id) {
    await recomputeGroupTotals(tx, row.repost_group_id);
  }
}
