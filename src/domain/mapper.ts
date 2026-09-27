import { z } from "zod";
import { stripControlChars, captionNormHash } from "./caption.js";
import { parseUrlExpiry } from "./url-expiry.js";
import { sanitizeUrl } from "../http/logger.js";
import type { AssetInput, MapResult, MappedMedia } from "./types.js";

const MAX_CAPTION_LENGTH = 10000;
const MAX_EXCERPT_LENGTH = 2000;

const childSchema = z.object({
  media_type: z.string().optional(),
  media_url: z.string().optional(),
});

const rawItemSchema = z.object({
  id: z.string().min(1),
  media_type: z.enum(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]),
  permalink: z.string().min(1),
  timestamp: z.string().min(1),
  media_url: z.string().optional(),
  // .nullable() alongside .optional(): Meta's API is not guaranteed to
  // omit these fields when they have no value — a null is treated the
  // same as absent, rather than rejecting the whole item.
  caption: z.string().optional().nullable(),
  like_count: z.number().optional().nullable(),
  comments_count: z.number().optional().nullable(),
  children: z.object({ data: z.array(childSchema) }).optional(),
});

function assetKindFor(mediaType: string | undefined): "image" | "video" {
  return mediaType === "VIDEO" ? "video" : "image";
}

function buildAssets(item: z.infer<typeof rawItemSchema>): AssetInput[] {
  if (item.media_type === "CAROUSEL_ALBUM" && item.children) {
    return item.children.data.map((child, position) => {
      const url = child.media_url ?? null;
      return {
        position,
        kind: assetKindFor(child.media_type),
        sourceUrl: url,
        sourceUrlExpiresAt: url ? parseUrlExpiry(url) : null,
        status: url ? "pending" : "no_url",
      };
    });
  }

  const url = item.media_url ?? null;
  return [
    {
      position: 0,
      kind: assetKindFor(item.media_type),
      sourceUrl: url,
      sourceUrlExpiresAt: url ? parseUrlExpiry(url) : null,
      status: url ? "pending" : "no_url",
    },
  ];
}

function excerptOf(raw: unknown): string {
  const json = JSON.stringify(raw) ?? "";
  const sanitized = json.replace(/"(https?:\/\/[^"]+)"/g, (_match, url: string) =>
    JSON.stringify(sanitizeUrl(url))
  );
  return sanitized.slice(0, MAX_EXCERPT_LENGTH);
}

function rejectedIgMediaId(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = (raw as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/**
 * Validates and maps one raw Meta API item into our domain shape, or
 * returns a rejection reason. Validation happens per item so that one
 * malformed item (bad media_type, missing field, NUL bytes that Postgres
 * would reject) never blocks the rest of a sync page.
 */
export function mapMetaItem(raw: unknown): MapResult {
  const parsed = rawItemSchema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path.join(".") || "unknown";
    return {
      rejected: {
        igMediaId: rejectedIgMediaId(raw),
        reason: `invalid field: ${field} (${firstIssue?.message ?? "validation failed"})`,
        excerpt: excerptOf(raw),
      },
    };
  }

  const item = parsed.data;

  const caption =
    item.caption !== undefined && item.caption !== null
      ? stripControlChars(item.caption).slice(0, MAX_CAPTION_LENGTH)
      : null;

  const mapped: MappedMedia = {
    igMediaId: item.id,
    mediaType: item.media_type,
    caption,
    captionNormHash: captionNormHash(caption),
    permalink: item.permalink,
    igTimestamp: new Date(item.timestamp),
    likeCount: item.like_count ?? null,
    commentsCount: item.comments_count ?? null,
    assets: buildAssets(item),
    raw,
  };

  return { ok: mapped };
}
