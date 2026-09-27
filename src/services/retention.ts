import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { Clock } from "../ports/clock.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import { outboxRepo } from "../db/repositories/outbox-repo.js";

export interface RetentionDeps {
  db: Kysely<DB>;
  clock: Clock;
  storage: BlobStorage;
  mediaRetentionDays: number;
}

const OUTBOX_PUBLISHED_RETENTION_DAYS = 7;

/**
 * The daily retention job (spec §6.8): clears expired raw payloads, deletes
 * media past MEDIA_RETENTION_DAYS together with its assets and snapshots
 * (cascade takes care of the DB rows; storage files are removed only when
 * no other asset still references the same content-addressed key), and
 * prunes old published outbox rows so that table doesn't grow forever.
 */
export async function runRetentionOnce(deps: RetentionDeps): Promise<void> {
  const { db, clock } = deps;
  const now = clock.now();

  await db.updateTable("media").set({ raw: null }).where("raw_expires_at", "<=", now).execute();

  const expiredMedia = await db
    .selectFrom("media")
    .select("ig_media_id")
    .where("first_seen_at", "<", new Date(now.getTime() - deps.mediaRetentionDays * 24 * 60 * 60 * 1000))
    .execute();

  for (const row of expiredMedia) {
    await deleteMediaByIgId(db, deps.storage, row.ig_media_id);
  }

  await db
    .transaction()
    .execute((tx) =>
      outboxRepo.deletePublishedOlderThan(
        tx,
        new Date(now.getTime() - OUTBOX_PUBLISHED_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      )
    );
}

/**
 * Deletes one post by its Instagram media ID: removes its stored files
 * (unless another asset still points to the same content-addressed
 * storage key — spec §6.8's dedup safety) and its database rows (assets
 * and engagement_snapshots cascade via FK; media_hashtags too). Returns
 * false if no such post exists.
 */
export async function deleteMediaByIgId(
  db: Kysely<DB>,
  storage: BlobStorage,
  igMediaId: string
): Promise<boolean> {
  const media = await db
    .selectFrom("media")
    .select("id")
    .where("ig_media_id", "=", igMediaId)
    .executeTakeFirst();
  if (!media) return false;

  const assets = await db
    .selectFrom("media_assets")
    .select(["storage_key"])
    .where("media_id", "=", media.id)
    .where("storage_key", "is not", null)
    .execute();

  for (const asset of assets) {
    const key = asset.storage_key!;
    const stillReferenced = await db
      .selectFrom("media_assets")
      .select("id")
      .where("storage_key", "=", key)
      .where("media_id", "!=", media.id)
      .executeTakeFirst();
    if (!stillReferenced) {
      await storage.delete(key);
    }
  }

  await db.deleteFrom("media").where("id", "=", media.id).execute();
  return true;
}
