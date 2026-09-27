# Hashtag Tracker — Instructions

Tracks the Instagram hashtag `matcha`: fetches top and recent media from the Meta Graph API, stores metadata in Postgres, downloads media assets to storage, avoids duplicates (including reposts under new IDs), and exposes a paginated `GET /hashtags` API.

Design spec: [`docs/superpowers/specs/2026-09-27-hashtag-tracker-design.md`](docs/superpowers/specs/2026-09-27-hashtag-tracker-design.md). Implementation plan: [`docs/superpowers/plans/2026-09-27-hashtag-tracker.md`](docs/superpowers/plans/2026-09-27-hashtag-tracker.md).

## setup

Requires Node.js 22+ and Docker (for local Postgres and for the integration tests, which run against a real Postgres via Testcontainers).

```bash
npm install
docker compose up -d          # starts local Postgres on 5432
cp .env.example .env
# edit .env: set META_ACCESS_TOKEN and META_IG_USER_ID to real values,
# and generate a CURSOR_SIGNING_KEYS value with:
#   echo "k1:$(openssl rand -base64 32)"
npm run migrate               # applies all migrations
npm run dev                   # starts the app (all roles, from APP_ROLES)
```

Once running:
- `GET http://localhost:3000/hashtags` — paginated feed
- `GET http://localhost:3000/healthz` — liveness

Run the test suite (includes real-Postgres integration tests via Testcontainers, so Docker must be running):

```bash
npm test              # all tests
npm run typecheck     # src/ only
npm run typecheck:all # src/ + test/
```

**A note on ports:** if `npm run dev` or the tests seem to hit something unexpected on `localhost:5432` or `localhost:3000`, check for another process already bound to those ports (this came up during development on a machine with a native Postgres install already running on 5432). Nothing in this project assumes exclusive use of those ports.

### Running one role only

`APP_ROLES` controls which parts of the app run in a given process (see spec §4.2). For example, to run only the API:

```bash
APP_ROLES=api npm run dev
```

Valid roles: `api`, `sync-worker`, `download-worker`, `relay`, `scheduler`.

## vars

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` requires `SECRETS_SOURCE=aws` (not yet implemented — see `tradeoffs`) |
| `APP_ROLES` | `api,sync-worker,download-worker,relay,scheduler` | Comma-separated |
| `PORT` | `3000` | API port |
| `METRICS_PORT` | `9100` | Reserved for Phase 2 (`/metrics`) |
| `DATABASE_URL` | — | **required** |
| `DATABASE_URL_READONLY` | — | Reserved for the Phase 3 GraphQL read pool |
| `DATABASE_URL_MIGRATOR` | — | Falls back to `DATABASE_URL` if unset |
| `SECRETS_SOURCE` | `env` | `env` or `aws`; `aws` is not implemented in this phase |
| `META_ACCESS_TOKEN` | — | **required**, secret — put only in `.env`, never commit |
| `META_APP_SECRET` | unset | Optional; enables `appsecret_proof` on every Meta call |
| `META_IG_USER_ID` | — | **required** |
| `META_API_VERSION` | `v24.0` | |
| `HASHTAG` | `matcha` | The tracked hashtag |
| `SYNC_INTERVAL_CRON` | `0 */3 * * *` | node-cron expression |
| `SYNC_MAX_ITEMS` | `500` | Per-sync item cap before truncation |
| `SYNC_SKEW_MINUTES` | `10` | Watermark skew buffer |
| `DOWNLOAD_CONCURRENCY` | `5` | Assets downloaded at once |
| `DOWNLOAD_MAX_ATTEMPTS` | `5` | Before an asset is dead-lettered |
| `DOWNLOAD_LEASE_SECONDS` | `120` | Claim lease before the sweeper reclaims |
| `MAX_ASSET_BYTES` | `104857600` (100 MB) | Streamed download cap |
| `MEDIA_HOST_ALLOWLIST` | `*.cdninstagram.com,*.fbcdn.net` | SSRF guard allowlist |
| `STORAGE_DIR` | `./storage` | Local disk storage root |
| `CURSOR_SIGNING_KEYS` | — | **required**, secret; `kid:base64key[,kid:base64key]` |
| `TRUST_PROXY` | `0` | Reserved for Phase 2 rate limiting |
| `REST_RATE_PER_MIN` / `REST_BURST` | `60` / `20` | Reserved for Phase 2 |
| `GRAPHQL_COST_PER_MIN` | `10000` | Reserved for Phase 3 |
| `RAW_RETENTION_DAYS` | `30` | How long raw Meta payloads are kept |
| `MEDIA_RETENTION_DAYS` | `180` | Reserved for the Phase 2 retention job |
| `SLACK_WEBHOOK_URL` | unset | Reserved for the Phase 2 watchdog |
| `SHUTDOWN_GRACE_MS` | `25000` | SIGTERM drain window |

See `.env.example` for a filled-in template with placeholder values.

## tradeoffs

**What this submission implements (Phase 1 — Core, per the plan's phasing):**
- Full ingestion pipeline: hashtag search (once, ever, per hashtag), top + recent media sync with pagination, watermark-based catch-up, and truncation handling above the 500-item cap.
- All tables created by Kysely migrations, including three Postgres roles (`tracker_migrator`, `tracker_app`, `tracker_graphql`) for later least-privilege enforcement.
- Media/asset metadata storage, with the raw Meta payload kept as `jsonb` for 30 days for later re-processing, then cleared.
- Local disk asset storage, content-addressed by SHA-256 (identical files are stored once).
- Duplicate handling: the same `ig_media_id` seen twice never creates a second row; reposts under a new ID are detected by exact file bytes first, then by a normalized-caption hash (only for captions ≥ 40 characters, to avoid false positives on short captions), linked via `repost_groups`, and hidden from `GET /hashtags` by default.
- Transactional outbox + relay + sweeper, so a crash between saving a row and queueing its job is always recoverable, and a worker crash mid-download is recovered by lease expiry.
- SSRF-guarded downloads: HTTPS-only, host allowlist, DNS resolved and checked against private/link-local ranges (including the cloud metadata addresses) before any connection, manual redirect following with per-hop re-validation, and a streamed byte cap.
- Keyset (cursor) pagination for `GET /hashtags`, signed with HMAC and supporting multiple keys for rotation, ordered by the Instagram post's own `timestamp`, not our insert time.
- Graceful shutdown on `SIGTERM`/`SIGINT`.

**What is explicitly out of scope for this submission, and why:**
- **Repost detection is limited to exact bytes and caption matching.** A re-encoded or cropped repost is not detected. Image-similarity hashing (e.g. perceptual hashing) would catch this but needs a different index structure and was out of scope for the time available.
- **Rate limiting on both sides (Meta calls and our own API), metrics, health/readiness checks beyond `/healthz`, alerting, and SLO tracking** are designed in the spec (§8, §9, §12, §14) but not yet implemented — they are Phase 2 in the plan. `MetaPage.usagePct` is always `null` right now because reading Meta's `X-Business-Use-Case-Usage` header needs the `HttpDownloader` port extended to expose response headers, which Phase 2 adds.
- **The GraphQL dashboard API** (engagement history, repost groups, query-cost limiting) is designed in spec §10 but not implemented — Phase 3.
- **AWS adapters (SQS, S3, EventBridge, Secrets Manager), the Pulumi infrastructure stack, and API-key authentication** are designed in spec §11 and §15 but not implemented — Phase 4. Everything runs locally: an in-memory queue, local disk storage, and `.env`-based secrets. `SECRETS_SOURCE=env` is refused in `NODE_ENV=production` (see `src/config/env.ts`), so the production path is at least gated even though the AWS side isn't built.
- **Distributed tracing** is not implemented; `sync_run_id` threads through logs and job payloads well enough to follow one sync's work by hand.
- **Multiple Instagram accounts** (needed to get around Meta's roughly 30-unique-hashtags-per-week limit at real scale) — the schema has room for it (`hashtags.account_id` would be a small addition), but wasn't built since this submission only tracks one hashtag.
- **A separate GraphQL/read-replica database role's actual read-only enforcement** exists as a Postgres role (`tracker_graphql`) with the right grants, but nothing in this phase connects as that role yet — that wiring is part of Phase 3.

**A known engineering tradeoff worth calling out:** node-postgres returns `bigint`/`int8` (which `bigserial` primary keys are) as JavaScript strings by default, to avoid silent precision loss above `Number.MAX_SAFE_INTEGER`. This project registers a global type parser (`src/db/pool.ts`) to return them as numbers instead, since every `id` column here is typed as `number` throughout the codebase and none of these counters will ever approach that limit. This is a deliberate, documented choice, not an oversight — but it is global to the process (any other `pg.Pool` created in the same process would also be affected), which is worth knowing if this code is ever embedded in a larger app.

## ai-usage

**Tools used:** Claude (Opus 5.5, and later this session running as Claude Sonnet 5), via Claude Code.

**What I used it for:**
- The full design conversation before any code was written: working through the four named failure modes (busy-hashtag truncation, expiring media URLs, reposts under new IDs, crash-between-save-and-queue), rate limiting on both sides, monitoring/alerting, SLOs, security risks, and production credential handling — each as a separate back-and-forth before locking in decisions.
- Writing the design spec (`docs/superpowers/specs/2026-09-27-hashtag-tracker-design.md`) and the phased implementation plan (`docs/superpowers/plans/2026-09-27-hashtag-tracker.md`) from that conversation.
- Test-first implementation of Phase 1: for each component, a failing test was written first from the plan's spec, then the minimal implementation, then verified against real Postgres (via Testcontainers) rather than mocks.

**What I reviewed, tested, or wrote myself:**
- I reviewed and approved every design decision at each step of the conversation (local-vs-AWS, repost visibility, "creation time" semantics, ECS Fargate, Pulumi, hashed API keys) before implementation began.
- Every test in this repo runs against a real Postgres database (via Testcontainers), not a mocked one — this was a hard constraint I set going in, specifically so the tests would catch real database-level bugs (constraint violations, transaction behavior, `FOR UPDATE SKIP LOCKED` semantics) rather than passing against a fake that agrees with whatever assumption was baked into it.
- Two real, non-trivial bugs were caught during implementation, not assumed away: (1) node-postgres returning `bigint` columns as strings, which silently broke cursor pagination round-tripping until a dedicated pagination test caught it; (2) Express 5's router requiring named wildcard parameters (`*splat` instead of bare `*`), which broke the `/files` route until a manual smoke test against a running server caught it (this route had no automated test until after the smoke test found the bug — see the added `test/http/files.test.ts`).
- I ran the manual smoke test myself as the final verification step: brought up a real Postgres via Docker, ran migrations, started the app, and hit `GET /hashtags` and `GET /healthz` with `curl`, and confirmed `SIGTERM` triggers a clean shutdown within the configured grace period.

No chat export is included with this submission; the design and build process is summarized above.
