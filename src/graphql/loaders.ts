import DataLoader from "dataloader";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import { mediaRepo } from "../db/repositories/media-repo.js";
import { repostGroupRepo } from "../db/repositories/repost-group-repo.js";

export interface GraphqlLoaders {
  mediaById: DataLoader<number, Awaited<ReturnType<typeof mediaRepo.findById>> | null>;
  assetsByMediaId: DataLoader<
    number,
    Awaited<ReturnType<typeof mediaRepo.findAssetsForMediaIds>>
  >;
  repostGroupById: DataLoader<number, Awaited<ReturnType<typeof repostGroupRepo.findByIds>>[number] | null>;
  storage: BlobStorage;
  readDb: Kysely<DB>;
}

/**
 * Builds a fresh set of DataLoaders per GraphQL request (spec §10). This is
 * what turns N per-post lookups into one batched SQL statement per field —
 * "50 posts with assets and repost groups run at most 3 SQL statements"
 * means: 1 for the feed page itself (done by the resolver before loaders
 * are even used), 1 batched call to assetsByMediaId, 1 batched call to
 * repostGroupById (mediaById is not on that hot path — Query.posts already
 * has the full media rows from feedPage).
 */
export function createLoaders(readDb: Kysely<DB>, storage: BlobStorage): GraphqlLoaders {
  const mediaById = new DataLoader<number, Awaited<ReturnType<typeof mediaRepo.findById>> | null>(
    async (ids) => {
      const rows = await mediaRepo.findByIds(readDb, [...ids]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.map((id) => byId.get(id) ?? null);
    }
  );

  const assetsByMediaId = new DataLoader<
    number,
    Awaited<ReturnType<typeof mediaRepo.findAssetsForMediaIds>>
  >(async (mediaIds) => {
    const rows = await mediaRepo.findAssetsForMediaIds(readDb, [...mediaIds]);
    const byMedia = new Map<number, typeof rows>();
    for (const row of rows) {
      const list = byMedia.get(row.media_id) ?? [];
      list.push(row);
      byMedia.set(row.media_id, list);
    }
    return mediaIds.map((id) => byMedia.get(id) ?? []);
  });

  const repostGroupById = new DataLoader<
    number,
    Awaited<ReturnType<typeof repostGroupRepo.findByIds>>[number] | null
  >(async (ids) => {
    const rows = await repostGroupRepo.findByIds(readDb, [...ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id) ?? null);
  });

  return { mediaById, assetsByMediaId, repostGroupById, storage, readDb };
}
