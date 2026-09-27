import type { Transaction } from "kysely";
import type { DB, AssetStatus } from "../schema.js";
import type { AssetInput } from "../../domain/types.js";

export interface UpsertAssetResult {
  assetId: number;
  newlyPending: boolean;
}

const REARMABLE_STATUSES: AssetStatus[] = ["pending", "url_expired"];

export const assetRepo = {
  /**
   * Upserts each asset for a post on (media_id, position). If an existing
   * asset is pending or url_expired and the incoming url differs, its url
   * and expiry are refreshed and it is set back to pending — this is how a
   * later sync re-arms a download after Meta returns a fresh signed URL
   * (spec §6.2 step 4, failure mode B).
   */
  async upsertMany(
    tx: Transaction<DB>,
    mediaId: number,
    assets: AssetInput[]
  ): Promise<UpsertAssetResult[]> {
    const results: UpsertAssetResult[] = [];

    for (const asset of assets) {
      const existing = await tx
        .selectFrom("media_assets")
        .selectAll()
        .where("media_id", "=", mediaId)
        .where("position", "=", asset.position)
        .executeTakeFirst();

      if (!existing) {
        const inserted = await tx
          .insertInto("media_assets")
          .values({
            media_id: mediaId,
            position: asset.position,
            kind: asset.kind,
            source_url: asset.sourceUrl,
            source_url_expires_at: asset.sourceUrlExpiresAt,
            status: asset.status,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        results.push({ assetId: inserted.id, newlyPending: asset.status === "pending" });
        continue;
      }

      const shouldRearm =
        REARMABLE_STATUSES.includes(existing.status) &&
        asset.sourceUrl !== null &&
        asset.sourceUrl !== existing.source_url;

      if (shouldRearm) {
        await tx
          .updateTable("media_assets")
          .set({
            source_url: asset.sourceUrl,
            source_url_expires_at: asset.sourceUrlExpiresAt,
            status: "pending",
          })
          .where("id", "=", existing.id)
          .execute();
        results.push({ assetId: existing.id, newlyPending: true });
        continue;
      }

      results.push({ assetId: existing.id, newlyPending: false });
    }

    return results;
  },

  /**
   * Atomically claims a pending asset for download: moves it to
   * `downloading` with a lease, only if it is currently `pending`. Returns
   * null if the asset was not in a claimable state (already claimed by
   * another worker, or in a terminal state) — the caller treats that as
   * "already handled" and acks the job.
   */
  async claim(tx: Transaction<DB>, assetId: number, leaseUntil: Date) {
    return tx
      .updateTable("media_assets")
      .set({ status: "downloading", lease_until: leaseUntil, attempts: (eb) => eb("attempts", "+", 1) })
      .where("id", "=", assetId)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
  },

  async markStored(
    tx: Transaction<DB>,
    assetId: number,
    fields: {
      contentSha256: string;
      storageKey: string;
      contentType: string;
      bytes: number;
      storedAt: Date;
    }
  ) {
    await tx
      .updateTable("media_assets")
      .set({
        status: "stored",
        content_sha256: fields.contentSha256,
        storage_key: fields.storageKey,
        content_type: fields.contentType,
        bytes: fields.bytes,
        stored_at: fields.storedAt,
        lease_until: null,
      })
      .where("id", "=", assetId)
      .execute();
  },

  async markStatus(
    tx: Transaction<DB>,
    assetId: number,
    status: AssetStatus,
    lastError?: string
  ) {
    await tx
      .updateTable("media_assets")
      .set({ status, last_error: lastError ?? null, lease_until: null })
      .where("id", "=", assetId)
      .execute();
  },

  async findById(tx: Transaction<DB>, assetId: number) {
    return tx.selectFrom("media_assets").selectAll().where("id", "=", assetId).executeTakeFirst();
  },

  /** Assets in `downloading` whose lease has passed — used by the sweeper. */
  async findExpiredLeases(tx: Transaction<DB>, now: Date) {
    return tx
      .selectFrom("media_assets")
      .selectAll()
      .where("status", "=", "downloading")
      .where("lease_until", "<", now)
      .execute();
  },

  /** Pending assets older than `olderThan` — used by the sweeper for lost queue messages. */
  async findStalePending(tx: Transaction<DB>, olderThanCutoff: Date) {
    return tx
      .selectFrom("media_assets")
      .innerJoin("media", "media.id", "media_assets.media_id")
      .select(["media_assets.id as id"])
      .where("media_assets.status", "=", "pending")
      .where("media.last_seen_at", "<", olderThanCutoff)
      .execute();
  },
};
