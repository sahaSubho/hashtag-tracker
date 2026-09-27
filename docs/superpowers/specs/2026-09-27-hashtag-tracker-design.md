# Hashtag Tracker — Design Spec

- **Date:** 2026-09-27
- **Status:** Draft, awaiting review
- **Source brief:** Saral BE Assignment ("Hashtag Tracking Assignment", Notion)
- **Stack:** Node.js 22 LTS, TypeScript, Express 5, Postgres 16

---

## 1. Summary

Track the Instagram hashtag `matcha`. Fetch top media and, every 3 hours, recent media from the Meta Graph API. Store the metadata in Postgres (all tables created by migrations), download the media files into storage, avoid duplicates (including reposts under new IDs), and expose a paginated `GET /hashtags` API. A GraphQL endpoint serves a dashboard. It must never slow down ingestion.

Queue, cron, storage and secrets sit behind interfaces. They run locally now (in-memory queue, node-cron, local disk, env variables) and switch to AWS in production (SQS, EventBridge Scheduler, S3, Secrets Manager) with no change to domain code. Production runs on ECS Fargate, provisioned with Pulumi.

The design is built around four failure modes, each covered by named tests (Section 7):

- **A.** Posts silently missed when a busy hashtag gets more than 500 posts in 3 hours.
- **B.** Media URLs expiring before we download them.
- **C.** Reposts under new IDs.
- **D.** Jobs lost if the worker crashes between saving and queueing.

## 2. Decisions log

| # | Decision | Choice |
|---|---|---|
| D1 | Local vs AWS for the submission | **Local** implementations; AWS versions designed behind the same interfaces |
| D2 | Repost visibility | Reposts are **stored and linked** to the original, and **never returned** by `GET /hashtags`. The dashboard sees them only through `repostGroup.members` |
| D3 | "Creation time" ordering | The Instagram post's `timestamp` field from the Meta response, not our insert time |
| D4 | Production compute | **ECS Fargate** |
| D5 | Infrastructure as code | **Pulumi** (TypeScript), self-managed S3 state backend with KMS encryption |
| D6 | Dashboard authentication | **Hashed API keys**, with scopes |
| D7 | Development method | Test-driven: every behaviour starts with a failing test (Section 16) |

## 3. Scope

### In scope
- Everything the brief requires, plus solutions to failure modes A–D.
- Rate limiting on both sides (calls to Meta, and requests to our API).
- A GraphQL dashboard API: engagement history and repost groups.
- Observability: logs, metrics, health endpoints, a watchdog that sends alerts, SLOs.
- Application-level security, and production secret handling.
- AWS adapters, graceful shutdown, a Pulumi stack with policy tests.

### Out of scope (listed in `tradeoffs`)
- Image-similarity repost detection. Only exact-byte and caption matches are detected.
- Distributed tracing (OpenTelemetry). The `sync_run_id` carries the trail through the pipeline.
- Multiple Instagram accounts to get past Meta's 30-hashtags-per-week limit. The schema leaves room for it.
- Cognito or any user-facing login.
- Actually deploying to AWS. The stack is written and tested with mocks and policies, not applied.

### Delivery phases
The plan will follow these phases. Each phase ends with every test passing.

| Phase | Contents |
|---|---|
| **P1 Core** (what the brief requires) | Migrations, config and logging, mapper and validation, Meta client, sync with watermark and 500-cap handling, outbox, download worker with SSRF guard, repost linking, sweeper and catch-up, `GET /hashtags`, cron, `instructions.md` |
| **P2 Hardening** | Meta throttle and backoff, API rate limiting, signed cursors, metrics, watchdog and alerts, health and status endpoints, retention and delete |
| **P3 Dashboard** | API keys, GraphQL, DataLoaders, query limits, read pool, response cache, rate limiting by cost |
| **P4 Production** | `SecretProvider` AWS version, SQS/S3/EventBridge adapters, graceful SIGTERM shutdown, Pulumi stacks and policy pack, migration-compatibility CI check |

## 4. Architecture

### 4.1 Interfaces and their implementations

Domain code depends only on these interfaces. Each interface has one shared contract test suite that every implementation must pass.

| Interface | Responsibility | Test fake | Local | Production |
|---|---|---|---|---|
| `MetaClient` | Hashtag search, `top_media`, `recent_media`, `debug_token` | Scripted pages from recorded fixtures | Graph API over `fetch` | Same |
| `Queue` | `enqueue(job, {delayMs})`, `receive`, `ack`, `release` | In-memory, with crash injection | In-memory | SQS |
| `BlobStorage` | `put(key, stream)`, `exists`, `getReadUrl` | In-memory map | Local disk under `STORAGE_DIR`, served at `/files/:key` | S3 with presigned GET links |
| `Scheduler` | Enqueue a sync every 3 hours | Manual trigger | node-cron | EventBridge Scheduler sending to SQS |
| `Clock` | Current time | Clock the test moves forward | `Date.now` | Same |
| `HttpDownloader` | Streamed download with guards | Scripted responses | `fetch` with the SSRF guard | Same |
| `DnsResolver` | Resolve hostnames for the SSRF check | Fake records | `dns.promises` | Same |
| `SecretProvider` | Read secrets | Static map | Env variables | Secrets Manager with 5-min cache |
| `Metrics` | Counters, gauges, histograms | Recorder | prom-client | CloudWatch embedded metric format |
| `AlertSink` | Send firing and resolved alerts | Recorder | Log line plus optional Slack webhook | SNS |
| `RateLimitStore` | Token buckets | In-memory | In-memory | ElastiCache (documented only) |
| `ReadDb` | Pool for GraphQL reads | Test database | Same Postgres, read-only role | RDS read replica |

**Postgres is never faked in tests.** Unique constraints, `ON CONFLICT`, `FOR UPDATE SKIP LOCKED`, transactions and database roles are exactly the behaviour under test.

### 4.2 Processes

Locally, one Node process runs everything. `APP_ROLES` selects which parts run, which allows splitting processes in production.

| Role | Does |
|---|---|
| `api` | REST, GraphQL, `/files` (local only), `/healthz`, `/readyz`, `/internal/status` |
| `sync-worker` | Handles `SYNC_HASHTAG_MEDIA` jobs |
| `download-worker` | Handles `DOWNLOAD_ASSET` jobs, at most `DOWNLOAD_CONCURRENCY` at once |
| `relay` | Publishes the outbox, runs the sweeper, the watchdog and the retention job |
| `scheduler` | node-cron (local only; EventBridge in production) |

`/metrics` is served on a separate internal port (`METRICS_PORT`).

### 4.3 Libraries

| Purpose | Library |
|---|---|
| Query builder and migrations | Kysely (migrations written in TypeScript) |
| Validation, including config | zod |
| Logging | pino |
| Metrics | prom-client |
| GraphQL | graphql-yoga, graphql-armor, dataloader |
| File-type detection from bytes | file-type |
| Tests | vitest, supertest, @testcontainers/postgresql |
| Infrastructure | Pulumi TS (`@pulumi/aws`, `@pulumi/awsx`), CrossGuard policy pack |
| AWS SDK | v3, imported only inside AWS adapters |

## 5. Data model

Every table is created by a Kysely migration. Timestamps are `timestamptz`.

### `hashtags`
| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `name` | text unique | e.g. `matcha` |
| `ig_hashtag_id` | text unique | Stored so hashtag search runs only once |
| `created_at` | timestamptz | |

### `media`
One row per Instagram post (per `ig_media_id`).

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `ig_media_id` | text **unique** | Catches the same post seen twice |
| `media_type` | text check (`IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`) | |
| `caption` | text null | NUL and control characters stripped |
| `caption_norm_hash` | text null | sha256 of the normalized caption; set only when the normalized length is ≥ 40 characters |
| `permalink` | text | |
| `ig_timestamp` | timestamptz | Post creation time (D3) |
| `like_count`, `comments_count` | int null | Latest values seen |
| `first_seen_at`, `last_seen_at` | timestamptz | |
| `repost_group_id` | bigint FK null | |
| `duplicate_of_id` | bigint FK null → `media.id` | Set on reposts; null on originals |
| `dup_reason` | text null check (`exact_bytes`, `caption`) | |
| `raw` | jsonb null | Original Meta item, with signed URLs removed |
| `raw_expires_at` | timestamptz | `first_seen_at + RAW_RETENTION_DAYS` (default 30) |

Indexes:
- `media_feed_idx ON media (ig_timestamp DESC, id DESC) WHERE duplicate_of_id IS NULL`
- `media_caption_hash_idx ON media (caption_norm_hash) WHERE caption_norm_hash IS NOT NULL`

**What we keep and why:** we keep the fields the API and dashboard serve, plus the raw payload for 30 days so we can re-process it. We drop signed CDN URLs from `raw`, because they expire and are sensitive. We don't store owner identity; hashtag endpoints don't return it and we won't add it.

### `media_hashtags`
`(media_id, hashtag_id)` primary key, plus `edges text[]` (which of `top` / `recent` returned it) and `first_seen_at`. A post can match several hashtags without being stored twice.

### `media_assets`
One row per file: one for an image or video, one per child for a carousel.

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `media_id` | FK | |
| `position` | int | 0 for single posts; carousel child index |
| `kind` | text (`image`, `video`) | |
| `source_url` | text null | Latest signed URL from Meta |
| `source_url_expires_at` | timestamptz null | Parsed from the URL's expiry parameter when present |
| `status` | text check | `pending`, `downloading`, `stored`, `url_expired`, `failed`, `no_url` |
| `attempts` | int | |
| `lease_until` | timestamptz null | Set while `downloading` |
| `content_sha256` | text null | |
| `storage_key` | text null | `sha256/<first 2 chars>/<hash>.<ext>` — identical files are stored once |
| `content_type`, `bytes` | text, bigint | |
| `stored_at` | timestamptz null | |
| `last_error` | text null | |

Unique on `(media_id, position)`. Index on `(status, source_url_expires_at)` for expiry-first ordering, and on `content_sha256`.

### `engagement_snapshots`
`(media_id, captured_at)` primary key, plus `like_count`, `comments_count`, `sync_run_id`. A row is added only when the counts differ from the latest snapshot. It's a single table; monthly partitioning is a documented scaling step (Section 15.6), not part of the initial migrations.

### `repost_groups`
| Column | Notes |
|---|---|
| `id` | bigserial PK |
| `canonical_media_id` | The member with the **earliest** `ig_timestamp` |
| `size`, `total_likes`, `total_comments` | Updated in the same transaction that links a member |
| `updated_at` | |

### `sync_runs`
| Column | Notes |
|---|---|
| `id` | uuid PK — this is the `sync_run_id` carried in logs and jobs |
| `hashtag_id`, `edge` | `edge` is `top` or `recent` |
| `parent_run_id` | Set on follow-up runs |
| `status` | `RUNNING`, `SUCCESS`, `TRUNCATED`, `FAILED` |
| `started_at`, `finished_at` | |
| `pages`, `items_fetched`, `items_new`, `items_rejected` | |
| `watermark_before` | Watermark used by this run |
| `newest_seen_ts`, `oldest_seen_ts` | |
| `resume_cursor` | Meta's `after` cursor when truncated or rate-limited |
| `gap_status` | `none`, `open`, `closed`, `unrecoverable` |
| `error_code`, `error_message` | |

### `rejected_items`
`id`, `sync_run_id`, `ig_media_id` (null if missing), `reason`, `payload_excerpt` (first 2 KB, with signed URLs removed), `created_at`.

### `outbox`
`id` bigserial, `kind`, `payload` jsonb, `created_at`, `available_at` (for delays), `published_at` null, `attempts`. Partial index on `(available_at) WHERE published_at IS NULL`. Published rows are deleted after 7 days.

### `dead_letters`
`id`, `job_kind`, `payload`, `attempts`, `last_error`, `created_at`.

### `alerts`
`alert_key` unique, `state` (`firing` / `resolved`), `fired_at`, `resolved_at`, `last_notified_at`, `details` jsonb.

### `api_keys`
`key_id` unique, `hash`, `name`, `scopes text[]`, `created_at`, `expires_at`, `last_used_at`, `revoked_at`.

### Database roles
| Role | Privileges |
|---|---|
| `tracker_migrator` | Owns the schema; schema changes. Used only by the migration command |
| `tracker_app` | SELECT/INSERT/UPDATE/DELETE on application tables; no schema changes |
| `tracker_graphql` | SELECT on the tables GraphQL reads; `statement_timeout = 2s` |

## 6. Flows

### 6.1 Bootstrap
1. Migrations run with the migrator role.
2. If `hashtags` has no row for `HASHTAG`, call `ig_hashtag_search` once and store `ig_hashtag_id`. **Hashtag search is never called when the ID is already stored.**
3. Catch-up: for each edge, if the last `SUCCESS` or `TRUNCATED` run finished more than `SYNC_INTERVAL` (3h) ago, or there has never been one, enqueue a sync through the outbox.

### 6.2 Sync (`SYNC_HASHTAG_MEDIA {hashtagId, edge, syncRunId, cursor?}`)
Runs for both edges every 3 hours: `recent` is what the brief requires, and running `top` too keeps engagement history fresh.

1. Create or resume the `sync_runs` row. Watermark = `newest_seen_ts` of the last run for this hashtag and edge whose status is `SUCCESS` or `TRUNCATED` with a closed gap. The first run has no watermark. A follow-up run uses its parent's `watermark_before`.
2. Fetch a page (`limit=25`) through the throttled `MetaClient`.
3. Validate and normalize each item (Section 6.6). Invalid items go to `rejected_items`, and the run continues.
4. **In one transaction**, for each valid item:
   - Upsert `media` on `ig_media_id`: refresh counts and `last_seen_at`; keep `first_seen_at`.
   - Upsert `media_hashtags`.
   - Add an engagement snapshot if the counts changed.
   - Upsert `media_assets`. If an asset is `url_expired` or `pending` and Meta now gives a different URL, update `source_url` and set it back to `pending`.
   - Insert one `DOWNLOAD_ASSET` outbox row for each asset that is newly `pending`.
   - Update the counters on `sync_runs`.
5. Stop conditions, checked after each page:
   - **Caught up** (edge `recent`): every item on the page has `ig_timestamp < watermark − SYNC_SKEW` (10 min). The status becomes `SUCCESS`, `gap_status = none`. We don't stop at the first already-seen ID, because pages aren't strictly ordered.
   - **No more pages:** `SUCCESS`.
   - **Item cap** (`SYNC_MAX_ITEMS = 500`) reached before catching up: status `TRUNCATED`, `gap_status = open`, save `resume_cursor`, and enqueue a follow-up run through the outbox with `parent_run_id`. When a follow-up catches up, it sets the parent's `gap_status = closed`.
   - **Rate limited:** save `resume_cursor` and re-enqueue with a delay (Section 8). The status stays `RUNNING`.
   - **Fatal error** (token error 190, invalid parameter): status `FAILED`, send a critical alert, no retry.
6. `top` has no watermark, so it stops at the cap or the last page.
7. **Unrecoverable gap:** the watchdog marks an `open` gap `unrecoverable` when `now − parent.oldest_seen_ts > 24h`, the limit of Meta's recent window. It raises a critical alert and increments `gap_unrecoverable_total`.
8. **Stale cursor:** if resuming from a saved cursor gets an invalid-cursor error, restart from page 1 with the same watermark. Upserts are safe to repeat, so this is harmless.

### 6.3 Outbox relay
Every `RELAY_INTERVAL_MS` (1000):

1. `SELECT … FROM outbox WHERE published_at IS NULL AND available_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100`
2. `queue.enqueue(...)`, then set `published_at` in the same transaction.

If the process crashes after enqueueing but before commit, the job is published twice. Every handler is safe to run twice, so this is fine. Delivery is **at-least-once**.

### 6.4 Download (`DOWNLOAD_ASSET {assetId}`)
1. Claim the asset: `UPDATE … SET status='downloading', lease_until=now()+DOWNLOAD_LEASE, attempts=attempts+1 WHERE id=$1 AND status IN ('pending') RETURNING *`. If no row comes back, the job is acknowledged as already handled.
2. Check the URL with the SSRF guard (Section 13.2), then download it streamed, with a timeout and size cap.
3. Detect the file type from its bytes. Only images and videos are allowed; anything else is `failed`, with no retry.
4. Hash the file while streaming it, then `put` it to storage under a key derived from the hash. Skip the upload if the key already exists.
5. **In one transaction:** mark the asset `stored` with hash, key, type, size and `stored_at`, then run repost linking (6.5).
6. Errors:
   - CDN 403, or 410, or the URL is past its known expiry: `url_expired`. There's no retry; a later sync with a fresh URL sets it back to `pending`.
   - Timeout, 5xx or CDN 429: back to `pending` with a backoff delay through the outbox, up to `DOWNLOAD_MAX_ATTEMPTS` (5), then `failed` plus a `dead_letters` row.
   - Guard rejection or disallowed type: `failed`, with no retry.
7. **An asset is never marked `stored` unless the object exists in storage and its hash matches.**

### 6.5 Repost linking
It runs inside the transaction that stores the **primary asset** (position 0). For posts with no URL, it runs at sync time using the caption only.

1. **Exact bytes:** another original post whose primary asset has the same `content_sha256`. Reason `exact_bytes`.
2. **Caption:** otherwise, another original post with the same `caption_norm_hash` and the same `media_type`. The hash only exists for normalized captions of at least 40 characters, which avoids false matches on short captions like "matcha 🍵". Reason `caption`.
3. On a match: join or create the `repost_group`. The canonical post is the member with the earliest `ig_timestamp`. If the new post is earlier, it becomes canonical and the previous canonical gets `duplicate_of_id` set. Recompute `size`, `total_likes` and `total_comments` from the members, all in the same transaction.
4. Counts updated by a later sync also refresh the group totals in that sync's transaction.

**Normalizing captions:** Unicode NFKC, lowercase, remove zero-width characters, collapse whitespace, trim.

**Known behaviour:** repost detection needs the file hash, so a repost can appear in `GET /hashtags` for a while until its download finishes. That window is bounded by SLO 3 (30 min). Re-encoded or cropped reposts are not detected; this goes in `tradeoffs`.

### 6.6 Validating Meta items
- Validated with a zod schema, **one item at a time**.
- NUL (`\u0000`) and other C0 control characters (except `\n` and `\t`) are stripped from all strings. Postgres rejects NUL in `text` and `jsonb`, so one bad caption would otherwise block the whole sync.
- Captions are capped at 10,000 characters.
- An unknown `media_type` or a missing `id`, `permalink` or `timestamp` → `rejected_items`.
- `CAROUSEL_ALBUM`: assets come from `children{media_type,media_url}` (requested in `fields`). A post with no URL at all gets one asset with status `no_url`.

### 6.7 Sweeper
Every 60 seconds:
- Assets in `downloading` whose `lease_until` has passed go back to `pending`, with a new outbox row. This covers a worker crashing mid-download.
- Assets in `pending` for more than 5 minutes with no unpublished outbox row get a new one. This covers the in-memory queue losing jobs on a crash.

Increments `sweeper_requeued_total`.

### 6.8 Retention
Runs daily:
- Set `raw` to null where `raw_expires_at` has passed.
- Delete media older than `MEDIA_RETENTION_DAYS` (default 180) together with its assets, snapshots and stored files. A stored file is deleted only when no other asset still points to it.
- Delete published outbox rows older than 7 days.
- `DELETE /internal/media/:igMediaId` (`admin` scope) deletes one post the same way.

### 6.9 Graceful shutdown (SIGTERM)
1. Stop receiving new jobs.
2. Wait up to `SHUTDOWN_GRACE_MS` (25s, under Fargate's `stopTimeout` of 30s) for in-flight jobs to finish.
3. Release the leases of any jobs still running (set assets back to `pending` and enqueue them again), then exit 0.

The API stops accepting connections and drains requests that are already in progress.

## 7. Failure modes and their required tests

### A. More than 500 posts in 3 hours
Handled by 6.2 steps 5–7 and the adaptive interval below.
- `sync stops when a page is entirely older than watermark − skew`
- `sync does not stop at the first already-seen ID when a page is out of order`
- `hitting the 500 cap before the watermark marks the run TRUNCATED with gap open, saves the cursor, and enqueues a follow-up`
- `the follow-up resumes from the saved cursor, stores all 700 items across 28 pages, and closes the parent's gap`
- `an open gap older than 24h becomes unrecoverable and raises a critical alert`
- `after 2 consecutive truncated runs, an extra sync is enqueued through the outbox with available_at = now + SYNC_INTERVAL / 2` (adaptive; the 3-hourly cron keeps running; the minimum gap between runs is 30 min)

### B. Media URLs expiring
Handled by 6.2 step 4 and 6.4.
- `a CDN 403 marks the asset url_expired with no blind retry`
- `the next sync with a fresh media_url sets the asset back to pending and the download completes`
- `pending assets are downloaded soonest-expiring first`
- `an asset is never stored unless the object exists and its hash matches`
- `a carousel creates one asset per child`; `a post with no media_url is stored with a no_url asset`

### C. Reposts under new IDs
Handled by 6.5.
- `the same ig_media_id synced twice gives one row, with counts updated and last_seen_at bumped`
- `a different ig_media_id with identical bytes is linked with exact_bytes, and storage holds one object`
- `an identical caption of at least 40 characters with the same media_type is linked with caption; a short caption is not linked`
- `an earlier-timestamped member arriving later becomes canonical`
- `repost group totals equal the sum of member rows, and a repeated sync doesn't double-count`
- `GET /hashtags never returns reposts`
- `a re-encoded repost is not detected` (documents the limit)

### D. Jobs lost between saving and queueing
Handled by 6.3, 6.7 and 6.9.
- `a crash after commit and before enqueue is recovered: the relay publishes the job on its next run`
- `a crash mid-download is recovered: the lease expires, the sweeper re-queues, and the result is exactly one object and one stored asset`
- `the same job delivered twice produces no duplicate rows or objects`
- `a missed cron window is recovered: on startup, a sync is enqueued if the last success is older than 3h`
- `a pending asset whose queue message was lost is re-queued by the sweeper`

## 8. Meta integration and rate limits

- **API version:** `META_API_VERSION` (default `v24.0`).
- **Fields requested:** `id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count,children{media_type,media_url}`.
- **Throttle:** one throttle per Instagram account, shared by every call. After each response it reads `X-Business-Use-Case-Usage` / `X-App-Usage`. At ≥ 80% usage it spaces calls out; at 100% it pauses every call until the reset time the header gives (or 15 minutes if none). It records the `meta_usage_pct` metric.
- **Error types:**

| Type | Examples | Handling |
|---|---|---|
| Rate limit | Codes 4, 17, 32, 613, 80002, or HTTP 429 | Save the cursor; re-enqueue with delay = max(reset time, backoff) |
| Temporary | 5xx, network, timeout | Exponential backoff with full jitter, base 30s, max 15 min, 5 attempts, then `FAILED` |
| Fatal | 190 (token), 100 (parameter), permission errors | Fail right away, critical alert, no retry. On 190, first fetch the secret again once (it may have just been rotated) |

- **Delays over 15 minutes** (the SQS maximum) are stored as `outbox.available_at`, and the relay publishes them when due. The `Queue` interface is the same either way.
- **Errors never contain the URL.** Graph API errors are wrapped so the request URL, and with it the token, never reaches `err.message`.
- **`appsecret_proof`:** when `META_APP_SECRET` is set, every call includes `appsecret_proof = HMAC-SHA256(key=app_secret, msg=access_token)`. It's required in production with "Require App Secret" turned on in the Meta app.
- **Token health:** a daily `debug_token` check warns 14 days before expiry and raises a critical alert if scopes change or the token is invalid.
- **Expected volume:** 2 edges × 8 runs a day × at most 20 pages ≈ 320 calls a day. The risks are loops, not volume.

## 9. REST API — `GET /hashtags`

**Request parameters:**
- `tag` (default `HASHTAG`). A hashtag we don't track returns 404.
- `limit`: default 20, maximum 100. Values above the maximum are clamped.
- `cursor`: opaque.

**Response 200:**
```json
{
  "data": [
    {
      "id": "123",
      "igMediaId": "1789…",
      "mediaType": "IMAGE",
      "caption": "…",
      "permalink": "https://www.instagram.com/p/…",
      "postedAt": "2026-09-27T08:15:00Z",
      "likeCount": 42,
      "commentsCount": 3,
      "assets": [
        { "position": 0, "kind": "image", "status": "stored", "contentType": "image/jpeg", "url": "…" }
      ]
    }
  ],
  "pageInfo": { "nextCursor": "…", "hasMore": true }
}
```

- **Order:** `ig_timestamp DESC, id DESC`. Reposts are excluded (`duplicate_of_id IS NULL`).
- **Pagination:** keyset. The cursor is base64url JSON `{t, id, kid}` signed with HMAC-SHA256 using the key named by `kid`. The server accepts every key in `CURSOR_SIGNING_KEYS` and signs with the first one.
- **Asset `url`:** `BlobStorage.getReadUrl(key)` (a local `/files/:key` path, or a presigned S3 link in production). It's null unless the status is `stored`.
- **Errors:** a malformed, tampered or unsigned cursor returns 400. Errors use the shape `{error:{code,message,requestId}}` and never include stack traces.
- **Response headers:** `X-Request-Id`, `RateLimit-*`, `X-Content-Type-Options: nosniff`.
- **Access:** public, as the brief doesn't mention authentication. Rate limited per IP: 60 requests per minute, burst of 20. The bucket key uses `req.ip`, with `TRUST_PROXY` set to the exact number of proxy hops (default off).

**Required tests:**
- `new posts arriving between page 1 and page 2 cause no duplicates and no skips`
- `a post inserted later with an older ig_timestamp sorts lower`
- `limit=10000 is clamped to 100`; `a tampered cursor returns 400`
- `a cursor signed with a previous key is accepted while that key is configured, and rejected after it's removed`
- `the query plan uses media_feed_idx`

## 10. GraphQL dashboard API

- **Endpoint:** `POST /graphql`. Requires an API key with the `dashboard:read` scope.
- **Server:** graphql-yoga.

```graphql
scalar DateTime
enum MediaType { IMAGE VIDEO CAROUSEL_ALBUM }
enum Bucket { HOUR DAY }

type Query {
  post(id: ID!): Post
  posts(first: Int!, after: String): PostConnection!   # originals only, same order as REST
  repostGroup(id: ID!): RepostGroup
}

type Post {
  id: ID!
  igMediaId: String!
  caption: String
  mediaType: MediaType!
  permalink: String!
  postedAt: DateTime!
  likeCount: Int
  commentsCount: Int
  assets: [Asset!]!
  engagementHistory(from: DateTime!, to: DateTime!, bucket: Bucket!, first: Int!): [EngagementPoint!]!
  repostGroup: RepostGroup
}

type Asset { position: Int!, kind: String!, status: String!, contentType: String, url: String }
type EngagementPoint { at: DateTime!, likeCount: Int, commentsCount: Int }

type RepostGroup {
  id: ID!
  canonical: Post!
  size: Int!
  totalLikes: Int!
  totalComments: Int!
  members(first: Int!, after: String): PostConnection!
}

type PostConnection { edges: [PostEdge!]!, pageInfo: PageInfo! }
type PostEdge { cursor: String!, node: Post! }
type PageInfo { endCursor: String, hasNextPage: Boolean! }
```

### Protecting the database
1. **Saved-query allowlist:** in production, only persisted operations registered by the dashboard are executed. Ad-hoc queries are allowed only when `NODE_ENV != production`.
2. **Backup limits** (graphql-armor):
   - maximum depth 5
   - maximum 10 aliases
   - maximum cost 1,000 per query, where a list costs its `first` value times the cost of what's inside it
   - every `first` is capped at 50
   - `engagementHistory` needs a range and bucket, and returns at most 500 points
3. **DataLoader** for posts, assets and repost groups, per request.
4. **Summary tables:** `repost_groups` is kept exact by ingestion. Engagement history is bucketed in SQL with `date_trunc` over the `(media_id, captured_at)` primary key.
5. **Response cache:** in-memory LRU, 30s TTL, keyed by operation, variables and key scope. It's cleared when a sync run finishes.
6. **Isolation:** GraphQL uses the `ReadDb` pool (maximum 5 connections, role `tracker_graphql`, 2s `statement_timeout`), fully separate from the ingestion pool.
7. **Rate limiting by cost:** each API key has a budget of 10,000 cost points per minute.
8. **Production settings:** introspection off; errors masked to a generic message plus `requestId`.

### Required tests
- `a query outside the allowlist is rejected in production mode`
- `depth 6 is rejected`
- `a query over the cost limit is rejected before any SQL runs`
- `first: 500 is rejected`
- `50 posts with assets and groups run at most 3 SQL statements`
- `with the GraphQL pool saturated, a sync job still finishes`
- `a query over 2s times out and returns a clean GraphQL error`
- `the tracker_graphql role cannot INSERT`
- `bucketed history matches buckets computed by hand`
- `a repeated identical query within the TTL runs 0 SQL statements`, and `a finished sync clears the cache`
- `a post's likes via GraphQL match GET /hashtags`

## 11. Authentication — hashed API keys

- **Format:** `dash_<keyId>_<secret>`. The `keyId` is 12 base32 characters; the secret is 32 random bytes, base64url-encoded.
- **Storage:** `hash = sha256(secret)`. The secret has 256 bits of randomness, so a slow password hash isn't needed.
- **Checking a request:** read `Authorization: Bearer <key>`, look up by `key_id`, compare hashes in constant time, then check expiry, revocation and scope. When the `key_id` is unknown, the server still hashes and compares against a dummy value, so both failures take the same time.
- **Scopes:** `dashboard:read` for GraphQL; `admin` for `/internal/status` and `DELETE /internal/media/:id`.
- **Creating and revoking keys:** only through CLI commands (`npm run apikey:create -- --name … --scopes …`, `apikey:revoke`). There is no HTTP endpoint for this. The key is printed once.
- `last_used_at` is updated at most once per minute per key.
- API keys are on the log redaction list.

**Required tests:**
- `a valid key authenticates`
- `a wrong secret with a real keyId returns 401, and an unknown keyId returns 401 through the same comparison`
- `a revoked or expired key returns 401`
- `a dashboard:read key calling /internal/status returns 403`
- `the database stores only the hash`
- `a key never appears in logs`
- `rate limit buckets are separate per key`

## 12. Observability

### 12.1 Logs
- pino JSON logs with fixed fields: `level`, `event`, `sync_run_id`, `job_id`, `media_id`, `asset_id`, `request_id`, `duration_ms`, `err`.
- `sync_run_id` is stored in outbox payloads and jobs, so one grep follows a post from fetch to stored file.
- **Fixed event names:** `sync.started`, `sync.page_fetched`, `sync.truncated`, `sync.completed`, `sync.failed`, `meta.rate_limited`, `meta.token_invalid`, `outbox.published`, `asset.stored`, `asset.download_failed{reason}`, `asset.url_rearmed`, `repost.linked`, `sweeper.requeued`, `item.rejected`, `api.rate_limited`, `graphql.rejected{rule}`, `alert.fired`, `alert.resolved`.
- **Removing secrets:**
  - pino redact paths cover `authorization`, `*.access_token`, `*.appsecret_proof` and `*.apiKey`.
  - A URL sanitizer strips `access_token` and `appsecret_proof` from Graph API URLs and the signature parameters from CDN URLs.
  - Captions are never logged.

### 12.2 Metrics
| Area | Metrics |
|---|---|
| Sync | `sync_runs_total{edge,status}`, `sync_items_fetched_total`, `sync_truncated_total`, `gap_unrecoverable_total`, `last_sync_success_timestamp{edge}` |
| Meta | `meta_calls_total{endpoint,code}`, `meta_usage_pct`, `meta_rate_limited_total` |
| Outbox and jobs | `outbox_pending`, `outbox_oldest_pending_age_seconds`, `sweeper_requeued_total`, `dead_letters_total` |
| Assets | `assets{status}`, `asset_download_failures_total{reason}`, `asset_url_rearmed_total`, `asset_capture_seconds` (histogram) |
| Reposts | `reposts_linked_total{reason}` |
| API | `http_request_duration_seconds{route,status}`, `http_429_total`, `graphql_rejected_total{rule}`, `db_pool_waiting{pool}` |

### 12.3 Health endpoints
- `/healthz`: the process is alive.
- `/readyz`: Postgres responds, migrations are current, and the relay and sweeper checked in within the last 2 minutes. Returns 503 otherwise.
- `GET /internal/status` (`admin` scope): the last run per edge, outbox backlog, asset counts by status, alerts currently firing.

### 12.4 Watchdog and alerts
Runs every 5 minutes against Postgres, so alerts work without a Prometheus server and survive restarts.

| Alert key | Condition | Severity |
|---|---|---|
| `sync_overdue:{edge}` | Last `SUCCESS` or `TRUNCATED` run more than 3h15m ago | critical |
| `meta_token_invalid` | Any code 190 error, or the `debug_token` check fails | critical, sent immediately |
| `meta_token_expiring` | Token expires within 14 days | warning |
| `sync_gap_open` | Gap still open 1h after truncation | warning |
| `sync_gap_unrecoverable` | Any gap marked unrecoverable | critical |
| `outbox_stalled` | Oldest unpublished row older than 10 min | critical |
| `assets_stuck` | Assets `pending` longer than 1h, or `url_expired` above 20% of a run's assets | warning |
| `meta_usage_high` | `meta_usage_pct` above 80% for 15 min | warning |
| `read_path_degraded` | GraphQL pool waiting > 0 for 5 min, or 5xx rate above 5% | warning |
| `dead_letters` | Any new dead-letter row | warning |
| SLO burn alerts | Section 14 | critical / warning |

- **Deduplication:** each alert notifies once when it starts firing and once when it resolves. The state lives in `alerts`, so a restart doesn't re-send.
- **Runbooks:** every alert key has a runbook section in `instructions.md` covering what it means, the first SQL to run, and the likely fix.
- **Required tests** (all with the fake clock):
  - `no alert at 3h10m, alert at 3h16m`
  - `no alert while a sync is running inside its window`
  - `an outbox row stuck for 11 min alerts`
  - `an alert notifies once, then resolves once`
  - `a restart doesn't re-send an alert that is already firing`
  - `a truncated 700-item run increments sync_truncated_total and logs sync.truncated with the cursor`
  - `a 403 increments asset_download_failures_total{reason="url_expired"}`
  - `a failed fetch against a URL containing access_token=abc logs no "abc", including inside err`
  - `/readyz returns 503 when Postgres is down`

## 13. Security

### 13.1 Secrets
- **Config** is validated with zod at startup; the app exits if anything required is missing or malformed.
- **Local:** secrets come from `.env`, which is git-ignored, with `.env.example` checked in.
- **Production:** `SECRETS_SOURCE=aws`. **The app refuses to start in production if secrets arrive as env variables or from a `.env` file.**
- **Scanning:** gitleaks as a pre-commit hook and in CI; GitHub secret scanning with push protection.
- **Fixtures:** recorded fixtures are scrubbed when recorded, and a test fails if any fixture or committed file contains `access_token=` or a string that looks like a token.

### 13.2 SSRF guard (download worker)
- HTTPS only.
- Host allowlist from `MEDIA_HOST_ALLOWLIST`, default `*.cdninstagram.com,*.fbcdn.net`.
- The hostname is resolved first, and the connection is made **to the checked IP**. Private, loopback, link-local, CGNAT and ULA addresses are rejected, including `169.254.169.254` and the ECS task endpoint `169.254.170.2`.
- Redirects are followed by hand, at most 3, and each hop is checked again.
- 30s timeout; streamed size cap `MAX_ASSET_BYTES` (default 100 MB) that aborts the download once the cap is passed.

**Tests:** each of these is rejected without a socket ever opening to the bad target:
- an `http://` URL
- a host outside the allowlist
- an allowed hostname that resolves to 10.x
- a redirect to `127.0.0.1`
- `169.254.170.2`

A body over the cap aborts after the cap has been read.

### 13.3 Other application-level controls
| Risk | Control | Test |
|---|---|---|
| One bad post blocking the sync | Item-by-item validation, NUL stripping, `rejected_items`, dead-letter after N attempts | A page with one NUL caption stores 24 items and rejects 1; a malformed job goes to dead-letter and the worker keeps running |
| Rate-limit bypass with `X-Forwarded-For` | `TRUST_PROXY` set to the exact hop count | With trust off, changing the header still gets a 429 |
| SQL injection | Only Kysely-parameterized queries; a lint rule bans raw SQL built from strings | A hostile cursor is rejected before reaching SQL |
| Stored XSS through captions | JSON only, `nosniff`, nothing rendered as HTML server-side | A `<script>` caption comes back as literal JSON text |
| Dangerous file content | File type detected from bytes against an allowlist; storage keys derived from hashes; `/files` served with `nosniff` and `Content-Disposition` | An HTML body behind an `image/jpeg` header is rejected |
| Too many database privileges | Three roles (Section 5) | `tracker_app` cannot DROP; `tracker_graphql` cannot INSERT |
| Internal endpoints exposed | `/metrics` on an internal port; `/internal/*` requires `admin`; introspection off in production; masked errors | Each has a test |
| Vulnerable dependencies | Committed lockfile, `npm ci`, `npm audit` / osv-scanner in CI, Dependabot | CI fails on a high-severity advisory |
| Personal data | Minimal fields, 30-day raw retention, `MEDIA_RETENTION_DAYS`, delete endpoint, captions never logged | Retention deletes rows past their TTL and orphaned files only |

## 14. SLOs (30-day window)

| # | SLO | Target | Measured from |
|---|---|---|---|
| 1 | Freshness: a `SUCCESS` or `TRUNCATED` recent-media run at least every 3h15m | 99% of 3h windows | `sync_runs` |
| 2 | Completeness: no window ends in an unrecoverable gap | 99.5% of windows | `sync_runs.gap_status` (a closed gap counts as good) |
| 3 | Asset capture: stored within 30 min of first being seen | 99% of downloadable assets | `stored_at − media.first_seen_at`; `no_url` excluded |
| 4 | Durability: stored objects readable with a matching hash | 99.99% | Nightly check of 100 random objects |
| 5 | REST availability | 99.9% non-5xx (429s excluded) | Request metrics |
| 6 | REST latency | p95 < 200 ms, p99 < 500 ms | Histogram |
| 7 | GraphQL | p95 < 800 ms, 99.5% non-5xx (limit rejections excluded) | Histogram |

- **Burn-rate alerts** for SLOs 1–3:
  - Page at 14.4× burn over 1h and 5min windows.
  - Ticket at 6× over 6h and 30min windows.
- The SLO calculator reads Postgres and is tested against fixture `sync_runs` data, including the case where a truncated run later closed its gap and counts as good.

## 15. Production (ECS Fargate + Pulumi)

### 15.1 Services
| ECS service | Scaling |
|---|---|
| `api` | At least 2 tasks behind ALB + WAF; scales on CPU and requests |
| `sync-worker` | 1–2 tasks |
| `download-worker` | Scales on the age of the oldest SQS message (tied to SLO 3) |
| `relay` | 1 task; running 2 is safe (`SKIP LOCKED`, and a row lock for the watchdog) |

- The scheduler is **EventBridge Scheduler** sending to SQS every 3h.
- Migrations run as a one-off ECS task in the pipeline, **before** the services update. Migrations must be backward-compatible (add first, remove in a later release). A CI check runs the previous release's tests against the new schema.
- `stopTimeout` is 30s, and `SHUTDOWN_GRACE_MS` is 25s.

### 15.2 Credentials
- **Meta:**
  - A System User token from Business Manager, with only the scopes needed (`instagram_basic` plus Instagram Public Content Access, pending App Review and Business Verification).
  - "Require App Secret" on, so every call carries `appsecret_proof`.
  - The token and the app secret are **separate** Secrets Manager secrets, encrypted with a customer-managed KMS key, readable only by the sync-worker role.
  - Fetched at runtime with a 5-min cache.
  - Rotated through current/pending versions, and fetched again once on a 190 error.
  - Separate Meta apps, accounts and tokens for staging and production.
- **AWS:**
  - No long-lived access keys. Tasks use IAM roles, and CI uses GitHub OIDC restricted to the protected `main` deploy job.
  - Least privilege per role:
    - sync worker: read the Meta secrets, send to SQS
    - download worker: receive from SQS, `PutObject` on `media/*`
    - api: read-only database access, presign `GetObject`
    - graphql: replica credentials only
    - migrator: pipeline only
  - Organization policies (SCPs) deny disabling CloudTrail or GuardDuty, deny unencrypted storage, and restrict regions.
- **Database:** RDS IAM authentication (15-min tokens), one identity per role, `rds.force_ssl=1`, with the CA verified by the app.
- **Application secrets:** cursor signing keys (rotatable by `kid`) and the Slack/SNS configuration live in Secrets Manager.
- **Access by people:** only through a break-glass role. CloudTrail logs every `GetSecretValue`, and **an alert fires on any read of a Meta secret by something other than the service role**.

### 15.3 Network and data
- Private subnets for tasks and RDS. VPC endpoints for S3, SQS, Secrets Manager and ECR.
- **Outbound traffic allowlist** through AWS Network Firewall: only `graph.facebook.com` and the Meta CDN domains.
- S3:
  - private, with public access blocked
  - bucket policy that denies non-TLS requests
  - SSE-KMS encryption and versioning
  - media served only through presigned links with a 15-min TTL
- RDS encrypted with point-in-time recovery; backups copied to a separate account. SQS with server-side encryption.
- CloudTrail across the organization, GuardDuty, Security Hub and AWS Config, all sending to SNS and on to `AlertSink`.
- Docker images: Trivy scan for vulnerabilities and baked-in secrets, base images pinned by digest, ECR scanning on push.

### 15.4 Pulumi
- **State:** S3 backend (`pulumi login s3://…`) with `--secrets-provider awskms://…`.
- **Stacks:** `staging` and `prod`, in separate AWS accounts.
- **Pipeline:** `pulumi preview` on pull requests and `pulumi up` from `main`.
- **Secret values are never set through Pulumi config.** Secrets are created empty and their values set separately with the CLI, so they never appear in state.
- **Unit tests** (`setMocks`, run in vitest):
  - the download role's `PutObject` is limited to `media/*`
  - only the sync role can read the Meta secrets
  - only app security groups can reach RDS inbound
  - Meta secret resources have no value
- **CrossGuard policy pack** (mandatory; blocks the deploy):
  - no `*` in IAM actions or resources
  - S3 public access blocked
  - RDS encrypted with TLS forced
  - SQS encrypted
  - no `0.0.0.0/0` inbound except 443 on the ALB
  - no task-definition env variables whose names look like secrets

### 15.5 Leak runbook (Meta token)
1. Revoke the System User token. If the app secret may also be exposed, reset it.
2. Put a new token in Secrets Manager. Workers pick it up within 5 min.
3. Review CloudTrail and Meta's app usage to find how the leak happened.
4. Backfill gaps from saved cursors while still inside 24h.

### 15.6 What breaks first at scale
The limits are listed in order. The numbers are estimates until the load test runs.

1. **More hashtags:** Meta's 30-unique-hashtags-per-week-per-account limit. It needs a pool of Instagram accounts (`hashtags.account_id`), not more servers. Next comes the per-account call budget, which needs staggered scheduling.
2. **More posts per hashtag:**
   - Constant truncation above about 500 posts per 3h, handled by the adaptive interval.
   - Then the **download backlog outrunning URL expiry**, the first real engineering failure (for example 5 workers × 10s per video ≈ 1,800 assets an hour). The warning signs are growing `assets{pending}` and `asset_capture_seconds`. The fix is scaling download workers on SQS message age.
   - Local disk filling up, solved by S3.
3. **More data and readers:**
   - `engagement_snapshots` growth: monthly partitions, rolling hourly data up to daily, dropping raw partitions.
   - Outbox bloat: delete published rows after 7 days.
   - Replica lag making GraphQL and REST disagree: the consistency test allows `REPLICA_LAG_TOLERANCE`, and `replica_lag_seconds` is tracked.
   - State kept in memory (rate limits, throttle, cache) needs ElastiCache once there's more than one task.

**Validation:** a load test with the fake `MetaClient` at 2k, 5k and 20k posts per 3h measures download lag and the expired-URL rate. k6 runs against a database seeded with 1M posts and 50M snapshots. The measured numbers replace the estimates in `tradeoffs`.

## 16. Testing strategy

### 16.1 Layers
| Layer | Scope | Tools |
|---|---|---|
| Unit | Pure functions: mapper, caption normalization, watermark stop logic, URL expiry parsing, cursor encoding and signing, backoff, API key parsing, SSRF IP classification | vitest |
| Integration | Repositories, migrations, outbox, sweeper, repost linking, roles — against real Postgres | vitest + Testcontainers; a template database per worker, migrated once and cloned per test file |
| Contract | One suite per interface, run against every implementation (fake, local, and AWS where credentials are present) | vitest `describe.each` |
| Scenario | Failure modes A–D end to end with fakes and crash injection | vitest + fake clock + scripted `MetaClient` |
| HTTP | REST and GraphQL through the real Express app | supertest |
| Infrastructure | Pulumi mocks plus the CrossGuard policy pack | vitest + `pulumi preview --policy-pack` |
| Live smoke (optional) | Real Meta API, read-only | Runs only when `META_LIVE=1` |
| Load (manual) | Section 15.6 | Fake Meta generator, k6 |

### 16.2 Rules
- Every behaviour in this spec starts as a failing test named after the behaviour. The test names in Sections 7, 9–13 and 15 are the minimum set.
- Fixtures are recorded from the real API once, scrubbed when recorded, and checked by the leak test.
- Tests never sleep: all time goes through `Clock`, and all waiting through controllable schedulers.
- CI runs lint, typecheck, unit, integration, contract, scenario, HTTP and infrastructure tests, then gitleaks, `npm audit` and Trivy.

## 17. Configuration (`vars` section of `instructions.md`)

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `APP_ROLES` | `api,sync-worker,download-worker,relay,scheduler` | |
| `PORT` / `METRICS_PORT` | `3000` / `9100` | |
| `DATABASE_URL` | — | `tracker_app` |
| `DATABASE_URL_READONLY` | — | `tracker_graphql` |
| `DATABASE_URL_MIGRATOR` | — | Migrations only |
| `SECRETS_SOURCE` | `env` | `aws` in production |
| `META_ACCESS_TOKEN` | — | Secret |
| `META_APP_SECRET` | unset | Secret; turns on `appsecret_proof` |
| `META_IG_USER_ID` | — | |
| `META_API_VERSION` | `v24.0` | |
| `HASHTAG` | `matcha` | |
| `SYNC_INTERVAL_CRON` | `0 */3 * * *` | |
| `SYNC_MAX_ITEMS` / `SYNC_SKEW_MINUTES` | `500` / `10` | |
| `DOWNLOAD_CONCURRENCY` / `DOWNLOAD_MAX_ATTEMPTS` / `DOWNLOAD_LEASE_SECONDS` | `5` / `5` / `120` | |
| `MAX_ASSET_BYTES` | `104857600` | |
| `MEDIA_HOST_ALLOWLIST` | `*.cdninstagram.com,*.fbcdn.net` | |
| `STORAGE_DIR` | `./storage` | Local only |
| `CURSOR_SIGNING_KEYS` | — | `kid:base64key[,kid:base64key]`; secret |
| `TRUST_PROXY` | `0` | Number of proxy hops |
| `REST_RATE_PER_MIN` / `REST_BURST` | `60` / `20` | |
| `GRAPHQL_COST_PER_MIN` | `10000` | |
| `RAW_RETENTION_DAYS` / `MEDIA_RETENTION_DAYS` | `30` / `180` | |
| `SLACK_WEBHOOK_URL` | unset | Secret; optional |
| `SHUTDOWN_GRACE_MS` | `25000` | |

## 18. Deliverables

- Repository shared with `saral-kalwani`, `pranav-getsaral` and `nivekithan-saral`.
- `instructions.md` at the root, with the headers `setup`, `vars`, `tradeoffs` and `ai-usage`, plus `production` and `runbooks`.
- `ai-usage/` folder containing exported AI chat history with secrets removed.
- `docker-compose.yml` for local Postgres; `npm run migrate`, `npm run dev`, `npm test`.

## 19. Assumptions to confirm against the live API (Phase 1, Meta client step)

Each has a defined fallback, so the design doesn't depend on the answer.

| Assumption | How it's confirmed | Fallback if wrong |
|---|---|---|
| `top_media` returns `timestamp` | Recorded fixture | Store null `ig_timestamp`; top-only posts sort by `first_seen_at` (the column becomes nullable and the index uses `COALESCE`) |
| Media URLs are on `*.cdninstagram.com` / `*.fbcdn.net` | Fixture hosts | Update the default `MEDIA_HOST_ALLOWLIST` |
| Rate-limit error codes and usage-header format | Meta docs plus fixtures of error responses | Treat any HTTP 429 / 4xx rate-limit message as a rate limit |
| `children{media_type,media_url}` works on hashtag media | Fixture | Carousel posts get a `no_url` asset and are documented |
| Maximum page size | Try `limit=50` | Keep 25 |
| Production scopes and App Review needs | Meta docs | Documented as launch lead time in `production` |
