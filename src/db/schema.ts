import type { ColumnType, Generated, JSONColumnType } from "kysely";

export type MediaType = "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
export type AssetKind = "image" | "video";
export type AssetStatus =
  | "pending"
  | "downloading"
  | "stored"
  | "url_expired"
  | "failed"
  | "no_url";
export type SyncEdge = "top" | "recent";
export type SyncStatus = "RUNNING" | "SUCCESS" | "TRUNCATED" | "FAILED";
export type GapStatus = "none" | "open" | "closed" | "unrecoverable";
export type DupReason = "exact_bytes" | "caption";
export type AlertState = "firing" | "resolved";

export interface HashtagsTable {
  id: Generated<number>;
  name: string;
  ig_hashtag_id: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface MediaTable {
  id: Generated<number>;
  ig_media_id: string;
  media_type: MediaType;
  caption: string | null;
  caption_norm_hash: string | null;
  permalink: string;
  ig_timestamp: ColumnType<Date, Date | string, Date | string>;
  like_count: number | null;
  comments_count: number | null;
  first_seen_at: ColumnType<Date, string | undefined, never>;
  last_seen_at: ColumnType<Date, string | undefined, string>;
  repost_group_id: number | null;
  duplicate_of_id: number | null;
  dup_reason: DupReason | null;
  raw: JSONColumnType<Record<string, unknown>> | null;
  raw_expires_at: ColumnType<Date, Date | string | undefined, Date | string> | null;
}

export interface MediaHashtagsTable {
  media_id: number;
  hashtag_id: number;
  edges: string[];
  first_seen_at: ColumnType<Date, Date | string, never>;
}

export interface MediaAssetsTable {
  id: Generated<number>;
  media_id: number;
  position: number;
  kind: AssetKind;
  source_url: string | null;
  source_url_expires_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  status: AssetStatus;
  attempts: Generated<number>;
  lease_until: ColumnType<Date, Date | string | null, Date | string | null> | null;
  content_sha256: string | null;
  storage_key: string | null;
  content_type: string | null;
  bytes: string | number | null;
  stored_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  last_error: string | null;
}

export interface SyncRunsTable {
  id: Generated<string>;
  hashtag_id: number;
  edge: SyncEdge;
  parent_run_id: string | null;
  status: SyncStatus;
  started_at: ColumnType<Date, string | undefined, never>;
  finished_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  pages: Generated<number>;
  items_fetched: Generated<number>;
  items_new: Generated<number>;
  items_rejected: Generated<number>;
  watermark_before: ColumnType<Date, Date | string | null, never> | null;
  newest_seen_ts: ColumnType<Date, Date | string | null, Date | string | null> | null;
  oldest_seen_ts: ColumnType<Date, Date | string | null, Date | string | null> | null;
  resume_cursor: string | null;
  gap_status: Generated<GapStatus>;
  error_code: string | null;
  error_message: string | null;
}

export interface EngagementSnapshotsTable {
  media_id: number;
  captured_at: ColumnType<Date, Date | string, never>;
  like_count: number | null;
  comments_count: number | null;
  sync_run_id: string;
}

export interface RepostGroupsTable {
  id: Generated<number>;
  canonical_media_id: number;
  size: Generated<number>;
  total_likes: Generated<number>;
  total_comments: Generated<number>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface OutboxTable {
  id: Generated<number>;
  kind: string;
  payload: JSONColumnType<Record<string, unknown>>;
  created_at: ColumnType<Date, string | undefined, never>;
  available_at: ColumnType<Date, Date | string | undefined, Date | string>;
  published_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  attempts: Generated<number>;
}

export interface RejectedItemsTable {
  id: Generated<number>;
  sync_run_id: string;
  ig_media_id: string | null;
  reason: string;
  payload_excerpt: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface DeadLettersTable {
  id: Generated<number>;
  job_kind: string;
  payload: JSONColumnType<Record<string, unknown>>;
  attempts: number;
  last_error: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface AlertsTable {
  alert_key: string;
  state: AlertState;
  fired_at: ColumnType<Date, Date | string, Date | string>;
  resolved_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  last_notified_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  details: JSONColumnType<Record<string, unknown>> | null;
}

export interface ApiKeysTable {
  key_id: string;
  hash: string;
  name: string;
  scopes: string[];
  created_at: ColumnType<Date, string | undefined, never>;
  expires_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  last_used_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
  revoked_at: ColumnType<Date, Date | string | null, Date | string | null> | null;
}

export interface DB {
  hashtags: HashtagsTable;
  media: MediaTable;
  media_hashtags: MediaHashtagsTable;
  media_assets: MediaAssetsTable;
  sync_runs: SyncRunsTable;
  engagement_snapshots: EngagementSnapshotsTable;
  repost_groups: RepostGroupsTable;
  outbox: OutboxTable;
  rejected_items: RejectedItemsTable;
  dead_letters: DeadLettersTable;
  alerts: AlertsTable;
  api_keys: ApiKeysTable;
}
