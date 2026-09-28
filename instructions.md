# Hashtag Tracker — Instructions

Tracks the Instagram hashtag `matcha`: fetches top and recent media from the Meta Graph API, stores metadata in Postgres, downloads media assets to storage, avoids duplicates (including reposts under new IDs), and exposes a paginated `GET /hashtags` API plus a GraphQL dashboard API. Local by default; every external dependency (queue, storage, secrets, alerting) sits behind an interface with both a local and an AWS implementation.

Design spec: [`docs/superpowers/specs/2026-09-27-hashtag-tracker-design.md`](docs/superpowers/specs/2026-09-27-hashtag-tracker-design.md). Implementation plan: [`docs/superpowers/plans/2026-09-27-hashtag-tracker.md`](docs/superpowers/plans/2026-09-27-hashtag-tracker.md) — the plan's own inline "build notes" sections document several real bugs found and fixed while implementing each phase; worth reading if extending this.

## setup

Requires Node.js 22+ and Docker (for local Postgres, and for the integration tests, which run against real Postgres via Testcontainers, and real LocalStack for the AWS adapter tests).

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
- `GET http://localhost:3000/hashtags` — paginated feed (REST)
- `POST http://localhost:3000/graphql` — dashboard API (requires a `dashboard:read`-scoped API key; see [API keys](#api-keys))
- `GET http://localhost:3000/healthz` / `GET http://localhost:3000/readyz` — liveness / readiness
- `GET http://localhost:3000/internal/status` — operator snapshot (requires an `admin`-scoped API key)
- `GET http://localhost:9100/metrics` — Prometheus metrics (separate port, no auth — not meant to be public; see `production`)

Run the test suite (includes real-Postgres and real-LocalStack integration tests, so Docker must be running):

```bash
npm test              # all tests (currently ~360, ~20-25s)
npm run typecheck     # src/ only
npm run typecheck:all # src/ + test/
```

**A note on ports:** if `npm run dev` or the tests seem to hit something unexpected on `localhost:5432` or `localhost:3000`, check for another process already bound to those ports. Nothing in this project assumes exclusive use of those ports.

**A note on test speed and reliability:** `vitest.config.ts` sets `isolate: false` deliberately — see the comment there and the P4-02 entry in the plan doc. Without it, the Postgres/LocalStack container singletons in `test/helpers/{pg,localstack}.ts` each spawn a fresh container per test *file* instead of sharing one for the whole run, which both slows the suite down by 15-30x and, past a certain number of files, genuinely starves the Docker daemon and produces intermittent connection-reset failures that look like flaky tests but are the suite's own resource contention, not a bug being tested. With everything now sharing one Postgres container, `test/helpers/pg.ts` also raises that container's `max_connections` to 300 (the Postgres default of 100 became the next bottleneck once every file shared one container instead of getting its own) — see the plan doc's P4-02 entry for how this was found.

### Running one role only

`APP_ROLES` controls which parts of the app run in a given process (see spec §4.2). For example, to run only the API:

```bash
APP_ROLES=api npm run dev
```

Valid roles: `api`, `sync-worker`, `download-worker`, `relay`, `scheduler`.

### API keys

The GraphQL dashboard and the `/internal/*` operator endpoints are gated by hashed API keys (spec §11), not the shared bearer token an earlier phase used. Create one with:

```bash
npm run apikey:create -- --name my-dashboard-key --scopes dashboard:read
npm run apikey:create -- --name my-admin-key --scopes admin
npm run apikey:revoke -- --key-id <keyId>
```

The plaintext key (`dash_<keyId>_<secret>`) is printed once, at creation time, and never stored — only its SHA-256 hash lives in `api_keys`. Send it as `Authorization: Bearer <key>`.

## vars

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` requires `SECRETS_SOURCE=aws` (enforced in `src/config/env.ts`) and turns on the GraphQL persisted-operation allowlist, disables introspection, and masks unexpected resolver errors |
| `APP_ROLES` | `api,sync-worker,download-worker,relay,scheduler` | Comma-separated |
| `PORT` | `3000` | API port |
| `METRICS_PORT` | `9100` | Prometheus `/metrics`, served on a separate port |
| `DATABASE_URL` | — | **required** |
| `DATABASE_URL_READONLY` | — | The GraphQL dashboard's own pool (spec §10/§15.1); falls back to `DATABASE_URL` locally, which does **not** enforce read-only at the DB level in that case — only a real `tracker_graphql` connection string does |
| `DATABASE_URL_MIGRATOR` | — | Falls back to `DATABASE_URL` if unset |
| `SECRETS_SOURCE` | `env` | `env` (local) or `aws` (Secrets Manager) — see `production`. Also switches the queue/storage/alert-sink backend (see `src/index.ts`'s `usingAws` flag) |
| `AWS_REGION` | `us-east-1` | Only used when `SECRETS_SOURCE=aws` |
| `AWS_SQS_QUEUE_URL` / `AWS_S3_BUCKET` / `AWS_SNS_ALERT_TOPIC_ARN` | — | **required when `SECRETS_SOURCE=aws`** (the app fails fast with a clear error if unset) |
| `META_ACCESS_TOKEN` | — | **required**, secret — put only in `.env`, never commit |
| `META_APP_SECRET` | unset | Optional; enables `appsecret_proof` on every Meta call |
| `META_IG_USER_ID` | — | **required** |
| `META_API_VERSION` | `v24.0` | |
| `HASHTAG` | `matcha` | The tracked hashtag |
| `SYNC_INTERVAL_CRON` | `0 */3 * * *` | node-cron expression (local); the production EventBridge schedule is set separately in the Pulumi stack and must be kept in sync by hand |
| `SYNC_MAX_ITEMS` | `500` | Per-sync item cap before truncation |
| `SYNC_SKEW_MINUTES` | `10` | Watermark skew buffer |
| `DOWNLOAD_CONCURRENCY` | `5` | Assets downloaded at once |
| `DOWNLOAD_MAX_ATTEMPTS` | `5` | Before an asset is dead-lettered |
| `DOWNLOAD_LEASE_SECONDS` | `120` | Claim lease before the sweeper reclaims |
| `MAX_ASSET_BYTES` | `104857600` (100 MB) | Streamed download cap |
| `MEDIA_HOST_ALLOWLIST` | `*.cdninstagram.com,*.fbcdn.net` | SSRF guard allowlist |
| `STORAGE_DIR` | `./storage` | Local disk storage root (ignored when `SECRETS_SOURCE=aws`) |
| `CURSOR_SIGNING_KEYS` | — | **required**, secret; `kid:base64key[,kid:base64key]`; shared by REST and GraphQL pagination cursors |
| `TRUST_PROXY` | `0` | Express `trust proxy` hop count, for correct client-IP rate limiting behind a real proxy/ALB |
| `REST_RATE_PER_MIN` / `REST_BURST` | `60` / `20` | Per-IP token bucket on `GET /hashtags` |
| `GRAPHQL_COST_PER_MIN` | `10000` | Per-API-key cost budget on `/graphql` (spec §10) |
| `RAW_RETENTION_DAYS` | `30` | How long raw Meta payloads are kept before the retention job clears `media.raw` |
| `MEDIA_RETENTION_DAYS` | `180` | How long a post (and its assets/snapshots/stored files) is kept before the retention job deletes it |
| `SLACK_WEBHOOK_URL` | unset | Optional; `LogAlertSink` posts there in addition to logging (local only — production alerting goes through SNS instead, see `production`) |
| `SHUTDOWN_GRACE_MS` | `25000` | SIGTERM drain window — kept below the ECS task's `stopTimeout` (30s in the Pulumi stack) so the app always gets its full grace period before a hard kill |

See `.env.example` for a filled-in template with placeholder values (including the new `AWS_*` vars).

## tradeoffs

**What's fully implemented (all four plan phases):**
- **Ingestion (Phase 1):** hashtag search once ever per hashtag; top + recent media sync with pagination, watermark-based catch-up, and truncation handling above the 500-item cap with an automatic follow-up job; adaptive shortened re-sync after repeated truncation.
- **Storage:** all tables via Kysely migrations, including the three Postgres roles (`tracker_migrator`, `tracker_app`, `tracker_graphql`) with real grants; local disk or S3 asset storage, content-addressed by SHA-256; raw Meta payloads kept as `jsonb` for `RAW_RETENTION_DAYS`, then cleared by the retention job; whole posts deleted after `MEDIA_RETENTION_DAYS`, or on demand via `DELETE /internal/media/:igMediaId`.
- **Duplicate handling:** the same `ig_media_id` seen twice never creates a second row; reposts under a new ID are detected by exact file bytes first, then by a normalized-caption hash (captions ≥ 40 characters only, to avoid false positives on short captions), linked via `repost_groups` with totals kept exact, and hidden from `GET /hashtags` and GraphQL's `posts`/`post` by default (visible only through `repostGroup.members`).
- **Durability:** transactional outbox + relay + sweeper, so a crash between saving a row and queueing its job is always recoverable, and a worker crash mid-download is recovered by lease expiry; graceful `SIGTERM` shutdown that stops picking up new jobs but lets an in-flight one finish.
- **Security:** SSRF-guarded downloads (HTTPS-only, host allowlist, DNS resolved and checked against private/link-local/CGNAT ranges including the cloud metadata addresses before any connection, manual redirect following with per-hop re-validation, streamed byte cap); signed, rotatable keyset pagination cursors; hashed API keys with scopes and constant-time comparison; a secret-leak grep test over the whole repo and fixtures.
- **Rate limiting on both sides:** a Meta-usage-aware throttle with exponential backoff and a fatal/rate-limit/temporary error taxonomy (spec §8); a per-IP token bucket on REST; a per-API-key cost budget on GraphQL.
- **Observability:** structured logs with secret redaction and a `sync_run_id` that threads through a sync from fetch to stored file; Prometheus metrics (`/metrics`); a Postgres-backed watchdog that fires/resolves exactly 5 kinds of alert (see `runbooks` below) without depending on a metrics pipeline being up; `/healthz` and `/readyz`; an SLO calculator for sync freshness with burn-rate alerting.
- **GraphQL dashboard:** engagement history (bucketed), repost groups, DataLoader-batched resolvers proven to avoid N+1 queries against real Postgres; depth/alias/cost limits, a persisted-operation allowlist and disabled introspection in production, a 30s response cache cleared on every sync completion, and the per-key cost budget above.
- **AWS adapters:** SQS, S3, Secrets Manager (with a 5-minute cache), SNS, and an EventBridge-Scheduler placeholder — every one tested against real LocalStack, not a mocked SDK client. `src/index.ts` switches between local and AWS behind `SECRETS_SOURCE`.
- **Infrastructure as code:** a separate Pulumi TypeScript project (`infra/`) for the full production stack, with a CrossGuard policy pack and `setMocks`-based unit tests proving the least-privilege IAM scoping actually holds — see `production` below for what this does and doesn't cover.

**What is explicitly out of scope, and why:**
- **Repost detection is limited to exact bytes and caption matching.** A re-encoded or cropped repost is not detected. Image-similarity hashing (e.g. perceptual hashing) would catch this but needs a different index structure and was out of scope for the time available.
- **Only 5 of the spec's alert conditions are implemented** (§12.4 names more): `sync_overdue:{edge}`, `outbox_stalled`, `freshness_burn_rate_fast`/`_slow`, and `sync_gap_unrecoverable:{runId}`. Not implemented: Meta-token-health alerts, an assets-stuck alert, a Meta-usage-high alert, a dead-letter alert, and a read-path-degraded alert — all designed in the spec, none built, since the watchdog only checks the conditions listed above.
- **Only SLO 1 (freshness) has a calculator.** SLOs 2-7 (completeness, asset capture, durability, REST/GraphQL availability and latency) are defined with targets in the spec (§14) but have no corresponding query against this codebase's data yet.
- **Distributed tracing** is not implemented; `sync_run_id` threads through logs and job payloads well enough to follow one sync's work by hand.
- **Multiple Instagram accounts** (needed to get around Meta's roughly 30-unique-hashtags-per-week limit at real scale) — the schema has room for it (`hashtags.account_id` would be a small addition), but wasn't built since this submission only tracks one hashtag.
- **The Network Firewall's route-table wiring is manual.** `infra/`'s `EgressFirewall` creates the real firewall/rule-group/policy resources, but redirecting private-subnet egress *through* that endpoint (VPC route-table changes) is a documented manual step — see `production` below.
- **`pulumi up` has never been run against a real AWS account.** No AWS credentials exist in this environment, and applying it would create real, billed infrastructure. The stack is written, unit-tested via `setMocks`, and policy-checked — deploying it is a decision for whoever holds the AWS account.

**A known engineering tradeoff worth calling out:** node-postgres returns `bigint`/`int8` (which `bigserial` primary keys are) as JavaScript strings by default, to avoid silent precision loss above `Number.MAX_SAFE_INTEGER`. This project registers a global type parser (`src/db/pool.ts`) to return them as numbers instead, since every `id` column here is typed as `number` throughout the codebase and none of these counters will ever approach that limit. This is a deliberate, documented choice, not an oversight — but it is global to the process (any other `pg.Pool` created in the same process would also be affected), which is worth knowing if this code is ever embedded in a larger app.

## production

This section is deliberately concrete rather than a restatement of the design spec's estimates — it uses the real thresholds, alert keys, and file paths this codebase actually has.

**Deploying:**
1. `cd infra && npm install`
2. Set the required Pulumi config: `pulumi config set albCertificateArn <acm-cert-arn>` and `pulumi config set containerImage <ecr-image-uri>`. `pulumi config set hashtagId <id>` once the hashtag has been bootstrapped once (see step 4) — the EventBridge schedule needs it in its message body.
3. `pulumi preview`, then `pulumi up`, from an account with real AWS credentials (never done from this repo's own sessions).
4. **Database roles are not managed by Pulumi.** RDS creates the instance; the app's own migrations (`0001_roles.ts` onward) create `tracker_migrator`/`tracker_app`/`tracker_graphql` and their grants. Run migrations once, manually, against the new RDS instance before any service starts — the `infra/index.ts`-created migration task definition (`migrationTaskDefinitionArn` in the stack's outputs) is meant to be run via `aws ecs run-task` in a deploy pipeline step that happens **before** the 4 services below are updated, exactly as spec §15.1 describes for rolling-deploy safety. `test/integration/migration-compat.test.ts` and its `test/fixtures/schema-baseline.ts` fixture are the automated guardrail that a later migration doesn't silently break old code still running during that rollout.
5. **Secrets are created empty, on purpose** (`infra/components/secrets.ts`): after `pulumi up`, set the real values once, out-of-band, e.g. `aws secretsmanager put-secret-value --secret-id <arn-from-stack-output> --secret-string '<value>'`. Never through Pulumi — a value would then live in Pulumi state.
6. **The Network Firewall's egress allowlist is created but not wired into routing.** `infra/components/firewall.ts` creates the real rule group (allowlisting `graph.facebook.com`, `.cdninstagram.com`, `.fbcdn.net`), policy, and firewall endpoint — but redirecting the private subnets' NAT-bound egress through that endpoint requires VPC route-table changes specific to the exact AZ/NAT topology, which this stack does not make automatically (see that file's own doc comment for why). Wire this by hand, or extend `infra/components/network.ts`'s route tables, before relying on it as a real SSRF backstop in production; until then, the network firewall is the application-level `src/domain/ssrf.ts` guard.
7. `SHUTDOWN_GRACE_MS` (25000, app default) must stay below the ECS task definitions' `stopTimeout` (30, set in `infra/components/ecs.ts`) — confirmed already consistent, but re-check this if either number changes.

**Credential rotation and the leak runbook:**
1. **Revoke first.** In Meta Business Manager, revoke the System User token immediately. If the app secret may also be exposed, reset it too — that invalidates every `appsecret_proof` made with it.
2. Put a new token in Secrets Manager (`aws secretsmanager put-secret-value`, as in step 5 above). `SecretsManagerProvider`'s 5-minute cache means every running task picks up the new value within 5 minutes, with no redeploy — and a live 190 (token-invalid) error makes the sync worker refetch immediately rather than wait out the cache, via `HttpMetaClient`'s `refreshAccessToken` callback in `src/index.ts`.
3. Check CloudTrail for `secretsmanager:GetSecretValue` calls on the Meta secrets from anything other than the sync-worker task role (`infra/index.ts` scopes only that role to read them) — that's how the leak most likely happened.
4. Check `sync_runs` for any gap opened during the incident window and, if still inside the ~24h Meta `recent_media` lookback, let the normal truncation/follow-up mechanism close it; if the gap is already `unrecoverable` (the watchdog marks it so once it's older than 24h), that data is genuinely gone.
5. This repo never had the real token in it — the Notion assignment's token exists only in the person running this app's own local `.env`, git-ignored, and the secret-leak test in `test/unit/no-secrets.test.ts` guards against ever committing one.

## runbooks

One entry per alert key the watchdog (`src/services/watchdog.ts`) actually fires. `<key>` values with a suffix (`:recent`, `:<runId>`) are per-instance — the runbook is the same regardless of the suffix.

### `sync_overdue:{edge}` — critical
**Means:** no `SUCCESS`/`TRUNCATED` sync for this edge (`top` or `recent`) in longer than `SYNC_INTERVAL_CRON` + `syncOverdueGraceMs` (3h15m with the defaults).
**First query:** `SELECT * FROM sync_runs WHERE hashtag_id = <id> AND edge = '<edge>' ORDER BY started_at DESC LIMIT 5;` — is a run `RUNNING` and stuck, or has nothing been enqueued at all?
**Likely fix:** if nothing is running, check the `scheduler` role/EventBridge schedule actually fired (`SELECT * FROM outbox WHERE kind = 'SYNC_HASHTAG_MEDIA' ORDER BY created_at DESC LIMIT 5;`); if a run is stuck `RUNNING`, check the sync-worker's logs for that `sync_run_id` for a Meta API error that isn't being retried.

### `outbox_stalled` — critical
**Means:** the oldest unpublished `outbox` row is older than `outboxStallMs` (10 min) — the relay isn't publishing.
**First query:** `SELECT * FROM outbox WHERE published_at IS NULL ORDER BY available_at ASC LIMIT 10;`
**Likely fix:** confirm the `relay` role is actually running and not crash-looping; check for a queue-side outage (SQS throttling/outage) if `enqueue` calls are failing.

### `freshness_burn_rate_fast` — critical / `freshness_burn_rate_slow` — warning
**Means:** the recent sync failure ratio, extrapolated over the 30-day SLO window, is burning the freshness error budget at ≥14.4x (fast, 1h window) or ≥6x (slow, 6h window) the sustainable rate (spec §14). Not one bad sync — a pattern.
**First query:** `SELECT status, gap_status, error_code, error_message, started_at FROM sync_runs WHERE started_at > now() - interval '6 hours' ORDER BY started_at DESC;`
**Likely fix:** look for a repeating `error_code` across the failing runs — a fatal Meta error (expired token) needs a new token; a repeating temporary error suggests a Meta-side or network outage.

### `sync_gap_unrecoverable:{runId}` — critical
**Means:** a `TRUNCATED` run's gap stayed open past the ~24h Meta `recent_media` lookback window — that data is permanently gone, not just delayed. Fires once per affected run, since each is its own data-loss event.
**First query:** `SELECT * FROM sync_runs WHERE id = '<runId>';` and its children (`SELECT * FROM sync_runs WHERE parent_run_id = '<runId>';`) to see how far the follow-up chain got before giving up.
**Likely fix:** nothing recovers the lost window itself. Check whether the truncation chain was slow because of Meta rate-limiting (raising `SYNC_MAX_ITEMS` isn't the fix — the adaptive-interval logic in `sync-service.ts` should already be shortening the re-sync gap after repeated truncation; check the `sync.truncated` metric for a pattern).

---

## ai-usage

**Tools used:** Claude (Opus 5.5, then Sonnet 5 for the remainder of the session), via Claude Code.

**What I used it for:**
- The full design conversation before any code was written: working through the four named failure modes (busy-hashtag truncation, expiring media URLs, reposts under new IDs, crash-between-save-and-queue), rate limiting on both sides, monitoring/alerting, SLOs, security risks, and production credential handling — each as a separate back-and-forth before locking in decisions.
- Writing the design spec and the phased implementation plan (P1 Core, P2 Hardening, P3 Dashboard, P4 Production) from that conversation, then executing all four phases test-first.
- For P2-P4 (hardening, GraphQL dashboard, AWS/Pulumi), each task's plan entry was expanded with concrete file/interface detail against the real signatures from the previous phase immediately before implementing it, rather than all up front — so the detail reflects what actually exists, not a guess.

**What I reviewed, tested, or wrote myself:**
- I reviewed and approved every design decision at each step of the conversation (local-vs-AWS, repost visibility, "creation time" semantics, ECS Fargate, Pulumi, hashed API keys) before implementation began.
- Every test that touches a real dependency runs against the real thing — real Postgres via Testcontainers, real LocalStack for every AWS adapter — never a mocked client, specifically so the tests catch real behavior (constraint violations, `FOR UPDATE SKIP LOCKED` semantics, SQS visibility timeouts, S3 path-style addressing quirks) instead of agreeing with whatever assumption was baked into a mock.
- A number of real, non-obvious bugs were caught during implementation, not assumed away — the plan document's own "build notes" sections record each one in detail as they were found:
  - node-postgres returning `bigint` columns as strings, which silently broke cursor pagination round-tripping until a dedicated pagination test caught it.
  - A cross-version dependency conflict between `graphql-armor` (pinned to `graphql@^16`) and this project's original `graphql@17`, which made every one of armor's validation rejections surface as an unmasked HTTP 500 with an empty error body — root-caused by walking yoga's own error-handling source, not by guessing.
  - A test helper (`query-counter.ts`) that wrapped the wrong `pg` method and always reported 0 queries, which had been silently making an N+1-query regression test pass vacuously; found by noticing the "proof" never actually changed when the code did, fixed, and the real (correct) count confirmed.
  - `pool.connect()` returning an already-wrapped client on reuse, which double-executed queries once the query-counter above was fixed to intercept the right method — required a `WeakSet` guard, not just moving the wrap point.
  - `SyncWorker`/`DownloadWorker`'s `handleSigterm()`/`isRunning()` being dead code — the actual shutdown mechanism was `clearInterval` in `index.ts`, not the workers refusing new work themselves; harmless in practice but the doc comments overclaimed what the code did, fixed with real tests.
  - Vitest's default per-file worker-process isolation multiplying Testcontainers' Postgres/LocalStack containers by the number of test files, which caused genuine (not flaky-looking-but-fake) resource contention past ~60 test files — fixed with `isolate: false`, cutting a full test run from 300-700+ seconds to ~20 seconds.
  - `awsx.ec2.Vpc`'s subnet-id outputs resolving to `undefined` under Pulumi's `setMocks`, confirmed in isolation before working around it by building the VPC from plain `aws.ec2.*` resources instead.
  - Express 5's router requiring named wildcard parameters (`*splat` instead of bare `*`), which broke the `/files` route until a manual smoke test against a running server caught it.
- I ran manual smoke tests at each phase boundary: brought up real Postgres (and later LocalStack) via Docker, ran migrations, started the app, hit the REST and GraphQL endpoints with real requests, and confirmed `SIGTERM` triggers a clean shutdown within the configured grace period.

No chat export is included with this submission; the design and build process, including every bug found along the way, is summarized above and in the plan document's own inline notes.
