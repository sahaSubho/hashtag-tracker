export type MediaType = "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
export type AssetKind = "image" | "video";
export type PendingAssetStatus = "pending" | "no_url";

export interface AssetInput {
  position: number;
  kind: AssetKind;
  sourceUrl: string | null;
  sourceUrlExpiresAt: Date | null;
  status: PendingAssetStatus;
}

export interface MappedMedia {
  igMediaId: string;
  mediaType: MediaType;
  caption: string | null;
  captionNormHash: string | null;
  permalink: string;
  igTimestamp: Date;
  likeCount: number | null;
  commentsCount: number | null;
  assets: AssetInput[];
  raw: unknown;
}

export interface RejectedItem {
  igMediaId: string | null;
  reason: string;
  excerpt: string;
}

export type MapResult = { ok: MappedMedia } | { rejected: RejectedItem };
