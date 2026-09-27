import { Router } from "express";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";
import type { BlobStorage } from "../../ports/blob-storage.js";
import { encodeCursor, decodeCursor, type CursorSigningKey } from "../../domain/cursor.js";
import { hashtagRepo } from "../../db/repositories/hashtag-repo.js";
import { mediaRepo } from "../../db/repositories/media-repo.js";

export interface HashtagsRouteDeps {
  db: Kysely<DB>;
  storage: BlobStorage;
  cursorKeys: CursorSigningKey[];
  defaultHashtag: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function hashtagsRouter(deps: HashtagsRouteDeps): Router {
  const router = Router();

  router.get("/hashtags", async (req, res) => {
    const tagName = typeof req.query.tag === "string" ? req.query.tag : deps.defaultHashtag;
    const hashtag = await hashtagRepo.findByName(deps.db, tagName);
    if (!hashtag) {
      res.status(404).json({ error: { code: "hashtag_not_found", message: `unknown hashtag: ${tagName}`, requestId: req.id } });
      return;
    }

    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : DEFAULT_LIMIT;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    let after: { t: Date; id: number } | null = null;
    if (typeof req.query.cursor === "string") {
      try {
        const decoded = decodeCursor(req.query.cursor, deps.cursorKeys);
        after = { t: decoded.t, id: decoded.id };
      } catch {
        res.status(400).json({ error: { code: "invalid_cursor", message: "malformed or tampered cursor", requestId: req.id } });
        return;
      }
    }

    const rows = await mediaRepo.feedPage(deps.db, hashtag.id, limit, after);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const assets = await mediaRepo.findAssetsForMediaIds(
      deps.db,
      page.map((r) => r.id)
    );
    const assetsByMedia = new Map<number, typeof assets>();
    for (const a of assets) {
      const list = assetsByMedia.get(a.media_id) ?? [];
      list.push(a);
      assetsByMedia.set(a.media_id, list);
    }

    const data = await Promise.all(
      page.map(async (row) => {
        const rowAssets = assetsByMedia.get(row.id) ?? [];
        const assetDtos = await Promise.all(
          rowAssets.map(async (a) => ({
            position: a.position,
            kind: a.kind,
            status: a.status,
            contentType: a.content_type,
            url: a.status === "stored" && a.storage_key ? await deps.storage.getReadUrl(a.storage_key) : null,
          }))
        );
        return {
          id: String(row.id),
          igMediaId: row.ig_media_id,
          mediaType: row.media_type,
          caption: row.caption,
          permalink: row.permalink,
          postedAt: row.ig_timestamp.toISOString(),
          likeCount: row.like_count,
          commentsCount: row.comments_count,
          assets: assetDtos,
        };
      })
    );

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ t: last.ig_timestamp, id: last.id }, deps.cursorKeys) : null;

    res.status(200).json({
      data,
      pageInfo: { nextCursor, hasMore },
    });
  });

  return router;
}
