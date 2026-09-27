# Hashtag Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track the Instagram `matcha` hashtag — ingest top and recent media from the Meta Graph API on a 3-hour cycle, store metadata in Postgres, download assets to storage, dedupe reposts, and expose a paginated `GET /hashtags` API plus a GraphQL dashboard, with all outside dependencies behind swappable local/AWS interfaces.

**Architecture:** A single Node process runs role-selected components (`api`, `sync-worker`, `download-worker`, `relay`, `scheduler`) behind interfaces (`MetaClient`, `Queue`, `BlobStorage`, `Scheduler`, `Clock`, `SecretProvider`, and more). Durability comes from a transactional outbox in Postgres plus a lease sweeper; correctness comes from real-Postgres integration tests and scripted-fake scenario tests driving the four failure modes.

**Tech Stack:** Node 22, TypeScript, Express 5, Postgres 16, Kysely, zod, pino, vitest, supertest, @testcontainers/postgresql, graphql-yoga + graphql-armor + dataloader, prom-client, Pulumi.

**Spec:** `docs/superpowers/specs/2026-09-27-hashtag-tracker-design.md` — read it alongside this plan. Section references (§) point into it.

## Global Constraints

- **Runtime:** Node.js 22 LTS, TypeScript strict mode, ESM. Express 5, Postgres 16.
- **Migrations only:** every table and role is created by a Kysely migration. No manual DDL, no `synchronize`.
- **Interfaces first:** domain code imports interfaces, never a concrete `fetch`/`fs`/AWS SDK call. AWS SDK v3 is imported **only** inside files under `src/adapters/aws/`.
- **Postgres is never faked in tests.** Integration/scenario tests run against real Postgres via Testcontainers.
- **No sleeping in tests.** All time goes through the `Clock` interface; all polling loops are step-driven in tests.
- **Secrets never in git, logs, or fixtures.** `.env` is git-ignored. A test fails if any committed file or fixture contains `access_token=` or a token-shaped string. The Meta access token from the brief lives only in a local `.env`.
- **TDD:** every behaviour starts as a failing test named after the behaviour (the test names in spec §7, §9–§13, §15 are the minimum set).
- **Commits:** frequent, one per task minimum. End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Env var names and defaults** are exactly as in spec §17.

---

## Execution note on phases

This plan is written full-detail for **Phase 1 (Core)** — the tasks below, P1-01 through P1-18, deliver everything the assignment brief requires and all four failure modes A–D. Phases **P2 (Hardening)**, **P3 (Dashboard)** and **P4 (Production)** are captured as task outlines at the end (§Phase 2–4 Outlines). Before executing each of those phases, expand its outline into full-detail tasks using the real signatures produced by the previous phase. Do not execute an outline task as-is; expand it first. This avoids committing placeholder code for signatures that don't exist yet.

---

## File Structure (Phase 1)

```
hashtag-tracker/
  package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
  docker-compose.yml                     # local Postgres
  src/
    config/
      env.ts                             # zod-validated config, loaded once
    domain/
      types.ts                           # shared domain types (MediaItem, AssetInput, …)
      caption.ts                         # normalizeCaption, captionNormHash
      mapper.ts                          # Meta item -> validated domain rows
      watermark.ts                       # stop-condition logic (pure)
      url-expiry.ts                      # parse expiry from a signed URL
      cursor.ts                          # keyset cursor encode/decode/sign
      backoff.ts                         # exponential backoff with jitter
      ssrf.ts                            # IP classification + host allowlist (pure)
    ports/                               # the interfaces
      meta-client.ts  queue.ts  blob-storage.ts  scheduler.ts
      clock.ts  http-downloader.ts  dns-resolver.ts  secret-provider.ts
      metrics.ts  alert-sink.ts
    adapters/
      clock/system-clock.ts
      meta/http-meta-client.ts
      queue/in-memory-queue.ts
      storage/disk-storage.ts
      scheduler/node-cron-scheduler.ts
      downloader/fetch-downloader.ts
      dns/system-dns.ts
      secrets/env-secret-provider.ts
      metrics/prom-metrics.ts  metrics/noop-metrics.ts
      alerts/log-alert-sink.ts
    db/
      pool.ts                            # Kysely instance factory (app/readonly/migrator)
      schema.ts                          # Kysely DB type
      migrations/                        # NNNN-name.ts
      repositories/
        hashtag-repo.ts  media-repo.ts  asset-repo.ts
        sync-run-repo.ts  outbox-repo.ts  rejected-repo.ts
    services/
      sync-service.ts                    # runs a sync (§6.2)
      download-service.ts                # runs a download (§6.4)
      repost-service.ts                  # linking (§6.5)
      relay.ts  sweeper.ts  bootstrap.ts
    workers/
      sync-worker.ts  download-worker.ts
    http/
      app.ts                             # express app factory
      routes/hashtags.ts  routes/files.ts  routes/health.ts
      logger.ts                          # pino + redaction + URL sanitizer
    index.ts                             # role selection, wiring, shutdown
  test/
    helpers/pg.ts                        # Testcontainers + template-db clone
    helpers/fakes.ts                     # FakeClock, FakeQueue, ScriptedMetaClient, …
    fixtures/meta/                       # recorded API pages (scrubbed)
    unit/  integration/  contract/  scenario/  http/
```

Files that change together live together (a service and its repository dependency are separate files but one task often touches both). Each file has one responsibility; when a service file grows past ~200 lines, split by sub-responsibility.

---

## Phase 1: Core

### Task P1-01: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.yml`, `src/index.ts` (stub)
- Test: `test/unit/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test`, `npm run build`, `npm run migrate`, `npm run dev` scripts; ESM + strict TS; a running Postgres via compose.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/scaffold.test.ts
import { describe, it, expect } from "vitest";

describe("scaffold", () => {
  it("exposes the app version from package.json", async () => {
    const pkg = (await import("../../package.json", { with: { type: "json" } })).default;
    expect(pkg.name).toBe("hashtag-tracker");
    expect(pkg.type).toBe("module");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/scaffold.test.ts`
Expected: FAIL — no package.json / vitest not installed.

- [ ] **Step 3: Write minimal implementation**

`package.json` (key fields):
```json
{
  "name": "hashtag-tracker",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --import tsx --watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "migrate": "node --import tsx src/db/migrate.ts up",
    "typecheck": "tsc --noEmit"
  }
}
```
Install: `npm i express@^5 kysely pg zod pino pino-http prom-client dataloader graphql graphql-yoga @escape.tech/graphql-armor file-type` and `npm i -D typescript tsx vitest supertest @testcontainers/postgresql @types/node @types/express @types/pg @types/supertest`.

`tsconfig.json`: `"module":"NodeNext"`, `"moduleResolution":"NodeNext"`, `"target":"ES2023"`, `"strict":true`, `"resolveJsonModule":true`, `"outDir":"dist"`, `"rootDir":"src"`.

`.gitignore`: `node_modules`, `dist`, `.env`, `storage/`, `*.log`.

`.env.example`: every var from spec §17 with placeholder values (no real token).

`docker-compose.yml`: a `postgres:16` service on 5432 with a healthcheck.

`src/index.ts`: `console.log("hashtag-tracker")` stub.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/scaffold.test.ts` → PASS. Also `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: project scaffold (ts, esm, vitest, compose)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-02: Config loader (zod)

**Files:**
- Create: `src/config/env.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(source: Record<string,string|undefined>): AppConfig` and the `AppConfig` type. Fields: `nodeEnv`, `appRoles: string[]`, `port`, `metricsPort`, `databaseUrl`, `databaseUrlReadonly`, `databaseUrlMigrator`, `secretsSource: "env"|"aws"`, `hashtag`, `metaApiVersion`, `metaIgUserId`, `syncMaxItems`, `syncSkewMinutes`, `downloadConcurrency`, `downloadMaxAttempts`, `downloadLeaseSeconds`, `maxAssetBytes`, `mediaHostAllowlist: string[]`, `storageDir`, `cursorSigningKeys: {kid,key}[]`, `trustProxy`, `restRatePerMin`, `restBurst`, `rawRetentionDays`, `mediaRetentionDays`, `shutdownGraceMs`. Secrets (`metaAccessToken`, `metaAppSecret`, `slackWebhookUrl`) are read via `SecretProvider`, **not** here — but `env.ts` validates their presence rule (see step 3).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/env.js";

const base = {
  DATABASE_URL: "postgres://app@localhost/db",
  META_IG_USER_ID: "123",
};

describe("loadConfig", () => {
  it("applies defaults from spec §17", () => {
    const c = loadConfig(base);
    expect(c.hashtag).toBe("matcha");
    expect(c.syncMaxItems).toBe(500);
    expect(c.downloadConcurrency).toBe(5);
    expect(c.maxAssetBytes).toBe(104857600);
    expect(c.mediaHostAllowlist).toEqual(["*.cdninstagram.com", "*.fbcdn.net"]);
  });

  it("parses CURSOR_SIGNING_KEYS into kid/key pairs", () => {
    const c = loadConfig({ ...base, CURSOR_SIGNING_KEYS: "k1:AAA,k2:BBB" });
    expect(c.cursorSigningKeys).toEqual([{ kid: "k1", key: "AAA" }, { kid: "k2", key: "BBB" }]);
  });

  it("throws when a required var is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("in production rejects SECRETS_SOURCE=env", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", SECRETS_SOURCE: "env" }))
      .toThrow(/production/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/config.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

Build a zod schema over the raw env, with `.default()` per spec §17. Coerce numbers. Split `mediaHostAllowlist` on `,`. Parse `CURSOR_SIGNING_KEYS` as `kid:key` pairs. Add a `superRefine`: if `nodeEnv === "production"` and `secretsSource !== "aws"`, fail with a message containing "production" (this is the §13.1 rule "app refuses to start in production if secrets come from env"). Export `loadConfig` and `AppConfig = z.infer<...>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/config.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: zod config loader with prod secrets rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-03: Logger with secret redaction

**Files:**
- Create: `src/http/logger.ts`
- Test: `test/unit/logger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createLogger(opts?)` returning a pino logger; `sanitizeUrl(u: string): string` that strips `access_token`, `appsecret_proof`, and CDN signature params (`efg`, `_nc_ht`, `oh`, `oe`, `stp`, `ccb`, and any param whose name matches `/sig|token|proof/i`). Redaction paths cover `authorization`, `*.access_token`, `*.appsecret_proof`, `*.apiKey`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/logger.test.ts
import { describe, it, expect } from "vitest";
import { sanitizeUrl } from "../../src/http/logger.js";

describe("sanitizeUrl", () => {
  it("removes access_token", () => {
    const out = sanitizeUrl("https://graph.facebook.com/v24.0/x?fields=id&access_token=EAAsecret");
    expect(out).not.toContain("EAAsecret");
    expect(out).toContain("fields=id");
  });
  it("removes CDN signature params", () => {
    const out = sanitizeUrl("https://scontent.cdninstagram.com/v/x.jpg?oh=SIG&oe=DEAD&_nc_ht=host");
    expect(out).not.toContain("SIG");
    expect(out).not.toContain("DEAD");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/logger.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation**

`sanitizeUrl`: parse with `new URL`, delete matching params, return string; on parse failure return `"[unparseable-url]"`. `createLogger`: pino with `redact: { paths: [...], censor: "[redacted]" }`, level from env, ISO timestamps.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/logger.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pino logger with URL/secret sanitization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-04: Postgres test harness + first migration + roles

**Files:**
- Create: `test/helpers/pg.ts`, `src/db/pool.ts`, `src/db/schema.ts`, `src/db/migrate.ts`, `src/db/migrations/0001_hashtags.ts`, `src/db/migrations/0002_roles.ts`
- Test: `test/integration/migrations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `withTestDb(fn)` (spins a Testcontainers Postgres once per file, migrates a template DB, clones per test); `makeDb(url)` → Kysely instance; `runMigrations(db)`; the `DB` schema type (extended each migration task); the three roles `tracker_migrator`, `tracker_app`, `tracker_graphql`.

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/migrations.test.ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";

describe("migrations", () => {
  it("creates the hashtags table with a unique name", async () => {
    await withTestDb(async (db) => {
      await db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "1" }).execute();
      await expect(
        db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "2" }).execute()
      ).rejects.toThrow();
    });
  });

  it("creates the tracker_app role without schema privileges", async () => {
    await withTestDb(async (db) => {
      const rows = await db.selectFrom("pg_roles" as any).select("rolname" as any)
        .where("rolname" as any, "=", "tracker_app").execute();
      expect(rows.length).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/migrations.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation**

`test/helpers/pg.ts`: start `PostgreSQLContainer` in a module-level promise; migrate a `template1`-style base DB once; `withTestDb` creates a fresh DB `CREATE DATABASE t_<rand> TEMPLATE base`, connects, runs `fn`, drops it. `src/db/pool.ts`: `makeDb(url)` returns `new Kysely({ dialect: new PostgresDialect({ pool: new Pg.Pool({ connectionString: url }) }) })`. `src/db/migrate.ts`: Kysely `Migrator` with a `FileMigrationProvider` over `migrations/`, plus a CLI (`up`/`down`). `0001_hashtags.ts`: create `hashtags` (§5). `0002_roles.ts`: `CREATE ROLE`s (idempotent with `DO $$ ... IF NOT EXISTS`), grants per spec §5 (`tracker_graphql` gets `SET statement_timeout` via `ALTER ROLE ... SET statement_timeout = '2s'`). Grants for later tables are re-applied by each migration that creates a table (add a `grantAppTable(db, name)` helper).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/migrations.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pg test harness, migrator, hashtags table, db roles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-05: Remaining migrations (media, assets, joins, runs, outbox, aux)

**Files:**
- Create: `src/db/migrations/0003_media.ts`, `0004_media_hashtags.ts`, `0005_media_assets.ts`, `0006_sync_runs.ts`, `0007_engagement_snapshots.ts`, `0008_repost_groups.ts`, `0009_outbox.ts`, `0010_rejected_items.ts`, `0011_dead_letters.ts`, `0012_alerts.ts`, `0013_api_keys.ts`; update `src/db/schema.ts`
- Test: `test/integration/schema.test.ts`

**Interfaces:**
- Consumes: `withTestDb`, `grantAppTable`.
- Produces: the full `DB` schema type (all tables in spec §5), the `media_feed_idx` and `media_caption_hash_idx` indexes, all FKs and check constraints, and grants.

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/schema.test.ts
import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";

describe("schema", () => {
  it("enforces the unique ig_media_id", async () => {
    await withTestDb(async (db) => {
      const base = { ig_media_id: "m1", media_type: "IMAGE", permalink: "p",
        ig_timestamp: new Date().toISOString() };
      await db.insertInto("media").values(base as any).execute();
      await expect(db.insertInto("media").values(base as any).execute()).rejects.toThrow();
    });
  });

  it("has the partial feed index excluding reposts", async () => {
    await withTestDb(async (db) => {
      const r = await db.selectFrom("pg_indexes" as any).select("indexname" as any)
        .where("indexname" as any, "=", "media_feed_idx").execute();
      expect(r.length).toBe(1);
    });
  });

  it("rejects an unknown media_type via the check constraint", async () => {
    await withTestDb(async (db) => {
      await expect(db.insertInto("media").values({ ig_media_id: "m2", media_type: "STORY",
        permalink: "p", ig_timestamp: new Date().toISOString() } as any).execute()).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/schema.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation**

Write each migration exactly per spec §5 (columns, types, nullability, checks, FKs, indexes). `0003_media` includes `media_feed_idx` and `media_caption_hash_idx`. `sync_runs.id` is `uuid` default `gen_random_uuid()` (enable `pgcrypto` in `0001` or use `uuid-ossp`; prefer `gen_random_uuid()` from `pgcrypto`). Extend `schema.ts` with a Kysely `interface` per table using `Generated`, `ColumnType`, and `JSONColumnType` for `jsonb`. Call `grantAppTable` for each app table and grant SELECT to `tracker_graphql` on media/assets/snapshots/repost_groups.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/schema.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: full schema migrations (media, assets, runs, outbox, aux)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-06: Caption normalization + hash

**Files:**
- Create: `src/domain/caption.ts`
- Test: `test/unit/caption.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeCaption(raw: string): string` (NFKC, lowercase, strip zero-width, collapse whitespace, trim); `stripControlChars(s: string): string` (remove NUL and C0 except `\n`,`\t`); `captionNormHash(raw: string | null): string | null` (returns null when the normalized length < 40, else `sha256(normalized)` hex).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/caption.test.ts
import { describe, it, expect } from "vitest";
import { normalizeCaption, captionNormHash, stripControlChars } from "../../src/domain/caption.js";

describe("caption", () => {
  it("strips NUL bytes", () => {
    expect(stripControlChars("a\u0000b")).toBe("ab");
  });
  it("keeps newlines and tabs", () => {
    expect(stripControlChars("a\nb\tc")).toBe("a\nb\tc");
  });
  it("normalizes case and whitespace", () => {
    expect(normalizeCaption("  Matcha   Latte​ ")).toBe("matcha latte");
  });
  it("returns null hash for short captions", () => {
    expect(captionNormHash("matcha 🍵")).toBeNull();
  });
  it("returns a stable hash for long captions", () => {
    const long = "the best matcha latte recipe you will ever make at home, guaranteed";
    expect(captionNormHash(long)).toMatch(/^[0-9a-f]{64}$/);
    expect(captionNormHash(long)).toBe(captionNormHash(long.toUpperCase()));
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run test/unit/caption.test.ts` → FAIL.
- [ ] **Step 3: Write minimal implementation** — use `String.prototype.normalize("NFKC")`, regex `/[​-‍﻿]/g` for zero-width, `/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g` for control chars, `node:crypto` `createHash("sha256")`.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: caption normalization and dedup hash

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-07: URL expiry parsing

**Files:**
- Create: `src/domain/url-expiry.ts`
- Test: `test/unit/url-expiry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseUrlExpiry(url: string): Date | null` — reads Meta CDN expiry (`oe` is hex epoch seconds; also handle `_nc_exp`/`expires` decimal epoch). Returns null when none present or unparseable.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/url-expiry.test.ts
import { describe, it, expect } from "vitest";
import { parseUrlExpiry } from "../../src/domain/url-expiry.js";

describe("parseUrlExpiry", () => {
  it("parses the hex oe param", () => {
    const epoch = Math.floor(Date.now() / 1000) + 3600;
    const hex = epoch.toString(16);
    const d = parseUrlExpiry(`https://x.fbcdn.net/a.jpg?oe=${hex}`);
    expect(d?.getTime()).toBe(epoch * 1000);
  });
  it("returns null when absent", () => {
    expect(parseUrlExpiry("https://x.fbcdn.net/a.jpg")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write minimal implementation** — `new URL`, read `oe` (parseInt base 16), else `_nc_exp`/`expires` (base 10). Guard against non-finite / absurd values (before now-1yr or after now+30d → treat as null). This assumption is flagged in spec §19; keep the fallback.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: parse asset URL expiry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-08: Meta item mapper + validation

**Files:**
- Create: `src/domain/types.ts`, `src/domain/mapper.ts`
- Test: `test/unit/mapper.test.ts`

**Interfaces:**
- Consumes: `normalizeCaption`, `stripControlChars`, `captionNormHash`, `parseUrlExpiry`.
- Produces: types `MediaItem`, `AssetInput`, `MappedMedia`, `MapResult = {ok: MappedMedia} | {rejected: {igMediaId: string|null, reason: string, excerpt: string}}`; `mapMetaItem(raw: unknown): MapResult`. `MappedMedia` carries `igMediaId`, `mediaType`, `caption`, `captionNormHash`, `permalink`, `igTimestamp: Date`, `likeCount`, `commentsCount`, `assets: AssetInput[]`. `AssetInput` = `{position, kind, sourceUrl: string|null, sourceUrlExpiresAt: Date|null, status: "pending"|"no_url"}`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/mapper.test.ts
import { describe, it, expect } from "vitest";
import { mapMetaItem } from "../../src/domain/mapper.js";

const img = { id: "1", media_type: "IMAGE", permalink: "p", timestamp: "2026-09-27T08:00:00+0000",
  media_url: "https://x.fbcdn.net/a.jpg", caption: "hi", like_count: 5, comments_count: 1 };

describe("mapMetaItem", () => {
  it("maps a single image to one pending asset", () => {
    const r = mapMetaItem(img);
    expect("ok" in r && r.ok.assets).toEqual([
      { position: 0, kind: "image", sourceUrl: "https://x.fbcdn.net/a.jpg",
        sourceUrlExpiresAt: null, status: "pending" },
    ]);
  });
  it("strips NUL from captions instead of rejecting", () => {
    const r = mapMetaItem({ ...img, caption: "a\u0000b" });
    expect("ok" in r && r.ok.caption).toBe("ab");
  });
  it("maps a carousel to one asset per child", () => {
    const r = mapMetaItem({ ...img, media_type: "CAROUSEL_ALBUM", media_url: undefined,
      children: { data: [ { media_type: "IMAGE", media_url: "https://x.fbcdn.net/1.jpg" },
                          { media_type: "VIDEO", media_url: "https://x.fbcdn.net/2.mp4" } ] } });
    expect("ok" in r && r.ok.assets.length).toBe(2);
  });
  it("stores a post with no url as a no_url asset", () => {
    const r = mapMetaItem({ ...img, media_url: undefined, children: undefined });
    expect("ok" in r && r.ok.assets[0].status).toBe("no_url");
  });
  it("rejects an unknown media_type", () => {
    const r = mapMetaItem({ ...img, media_type: "STORY" });
    expect("rejected" in r && r.rejected.reason).toMatch(/media_type/);
  });
  it("rejects a missing id", () => {
    const r = mapMetaItem({ ...img, id: undefined });
    expect("rejected" in r).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write minimal implementation** — zod schema for the raw item; on parse failure return `{rejected}` with a reason naming the first failing field and a ≤2KB excerpt (with `sanitizeUrl` applied to any url-ish strings). On success, strip control chars from caption, cap at 10000 chars, compute hash, build assets: single → position 0 from `media_url`; carousel → map `children.data`; none → `no_url`. `kind` from `media_type`/child type (`VIDEO`→video else image). `igTimestamp` via `new Date` (Meta returns `+0000`).
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Meta item mapper with per-item validation and rejects

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-09: Ports (interfaces) + Clock adapter + fakes

**Files:**
- Create: all files under `src/ports/`, `src/adapters/clock/system-clock.ts`, `test/helpers/fakes.ts`
- Test: `test/unit/fakes.test.ts`

**Interfaces:**
- Consumes: `MappedMedia` etc.
- Produces: the interface types (signatures below) and test fakes.

Interface signatures (write these verbatim into `src/ports/`):
```ts
// clock.ts
export interface Clock { now(): Date; }
// queue.ts
export interface QueueJob { id: string; kind: string; payload: unknown; }
export interface Queue {
  enqueue(kind: string, payload: unknown, opts?: { delayMs?: number }): Promise<void>;
  receive(kinds: string[], max: number): Promise<QueueJob[]>;
  ack(job: QueueJob): Promise<void>;
  release(job: QueueJob, opts?: { delayMs?: number }): Promise<void>;
}
// blob-storage.ts
export interface BlobStorage {
  exists(key: string): Promise<boolean>;
  put(key: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<void>;
  getReadUrl(key: string): Promise<string>;
}
// meta-client.ts
export interface MetaPage { items: unknown[]; nextCursor: string | null; usagePct: number | null; }
export interface MetaClient {
  searchHashtag(name: string): Promise<string>; // returns ig_hashtag_id
  media(edge: "top" | "recent", hashtagId: string, cursor: string | null): Promise<MetaPage>;
  debugToken(): Promise<{ expiresAt: Date | null; scopes: string[]; valid: boolean }>;
}
// http-downloader.ts
export interface DownloadResult { body: AsyncIterable<Uint8Array>; contentType: string | null; }
export interface HttpDownloader { get(url: string): Promise<DownloadResult>; }
// dns-resolver.ts
export interface DnsResolver { resolve(host: string): Promise<string[]>; }
// secret-provider.ts
export interface SecretProvider { get(name: string): Promise<string | undefined>; }
// scheduler.ts
export interface Scheduler { start(): void; stop(): Promise<void>; }
// metrics.ts
export interface Metrics {
  inc(name: string, labels?: Record<string,string>, by?: number): void;
  gauge(name: string, value: number, labels?: Record<string,string>): void;
  observe(name: string, value: number, labels?: Record<string,string>): void;
}
// alert-sink.ts
export interface AlertSink { fire(key: string, severity: "warning"|"critical", details: unknown): Promise<void>;
  resolve(key: string): Promise<void>; }
```
Fakes in `test/helpers/fakes.ts`: `FakeClock(start)` with `advance(ms)`; `FakeQueue` (array-backed, honoring `delayMs` against a Clock, with `crashAfterEnqueue` hook); `ScriptedMetaClient(pages)`; `FakeStorage` (Map); `FakeDownloader(responses)` supporting status/redirect/slow bodies; `FakeDns(map)`; `RecordingMetrics`; `RecordingAlertSink`; `staticSecrets(map)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/fakes.test.ts
import { describe, it, expect } from "vitest";
import { FakeClock, FakeQueue } from "../helpers/fakes.js";

describe("fakes", () => {
  it("FakeQueue hides delayed jobs until the clock advances", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const q = new FakeQueue(clock);
    await q.enqueue("X", { a: 1 }, { delayMs: 1000 });
    expect(await q.receive(["X"], 10)).toHaveLength(0);
    clock.advance(1000);
    expect(await q.receive(["X"], 10)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write minimal implementation** — ports files (pure types) + `SystemClock` (`now(){return new Date()}`) + the fakes above.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: port interfaces, system clock, test fakes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-10: Repositories

**Files:**
- Create: `src/db/repositories/hashtag-repo.ts`, `media-repo.ts`, `asset-repo.ts`, `sync-run-repo.ts`, `outbox-repo.ts`, `rejected-repo.ts`
- Test: `test/integration/repositories.test.ts`

**Interfaces:**
- Consumes: `DB` schema, `MappedMedia`, `AssetInput`.
- Produces (key methods):
  - `mediaRepo.upsert(tx, m: MappedMedia, clock): Promise<{mediaId: number, isNew: boolean, countsChanged: boolean}>` — upsert on `ig_media_id`, refresh counts + `last_seen_at`, keep `first_seen_at`, set `caption_norm_hash`, write `raw` with `raw_expires_at`.
  - `assetRepo.upsertMany(tx, mediaId, assets): Promise<{assetId:number, newlyPending:boolean}[]>` — upsert on `(media_id, position)`; if existing status is `url_expired`|`pending` and url changed → set url/expiry, status `pending`.
  - `assetRepo.claim(tx, assetId, leaseUntil)`, `assetRepo.markStored(tx, …)`, `assetRepo.markStatus(tx, …)`, `assetRepo.dueForExpiry()`.
  - `syncRunRepo.create/resume/finish/updateCounters/latestWatermark(edge)`.
  - `outboxRepo.enqueue(tx, kind, payload, availableAt)`, `outboxRepo.claimBatch(tx, limit, now)`, `outboxRepo.markPublished(tx, id)`.
  - `rejectedRepo.insert(tx, …)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/repositories.test.ts (excerpt — write one test per bullet)
import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { FakeClock } from "../helpers/fakes.js";

const m = (over={}) => ({ igMediaId: "m1", mediaType: "IMAGE", caption: null, captionNormHash: null,
  permalink: "p", igTimestamp: new Date("2026-09-27T08:00:00Z"), likeCount: 1, commentsCount: 0,
  assets: [], raw: {}, ...over });

describe("mediaRepo.upsert", () => {
  it("inserts once and updates counts on the second sync", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const r1 = await db.transaction().execute(tx => mediaRepo.upsert(tx, m() as any, clock));
      expect(r1.isNew).toBe(true);
      const r2 = await db.transaction().execute(tx =>
        mediaRepo.upsert(tx, m({ likeCount: 9 }) as any, clock));
      expect(r2.isNew).toBe(false);
      expect(r2.countsChanged).toBe(true);
      const row = await db.selectFrom("media").selectAll().where("ig_media_id","=","m1").executeTakeFirst();
      expect(row!.like_count).toBe(9);
    });
  });
});
```
(Write sibling tests: asset upsert re-arming an `url_expired` asset to `pending`; `latestWatermark` returns the newest `ig_timestamp` of the last SUCCESS/closed run; outbox `claimBatch` respects `available_at` and `SKIP LOCKED`.)

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write minimal implementation** — Kysely queries using `onConflict`. All methods take a transaction/executor first arg so callers compose them in one transaction. `raw` stored via `sql` JSON. Use `FOR UPDATE SKIP LOCKED` in `outboxRepo.claimBatch` and `assetRepo` claim.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: repositories for media, assets, runs, outbox, rejects

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-11: Watermark stop-logic (pure)

**Files:**
- Create: `src/domain/watermark.ts`
- Test: `test/unit/watermark.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `decideStop(args: { edge: "top"|"recent"; pageTimestamps: Date[]; watermark: Date|null; skewMs: number; itemsSoFar: number; maxItems: number; hasNextCursor: boolean }): "caught_up"|"cap_reached"|"exhausted"|"continue"`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/watermark.test.ts
import { describe, it, expect } from "vitest";
import { decideStop } from "../../src/domain/watermark.js";
const ts = (s: string) => new Date(s);

describe("decideStop", () => {
  const wm = ts("2026-09-27T08:00:00Z");
  it("caught_up when every item is older than watermark minus skew", () => {
    expect(decideStop({ edge:"recent", pageTimestamps:[ts("2026-09-27T07:40:00Z")],
      watermark: wm, skewMs: 600000, itemsSoFar: 25, maxItems: 500, hasNextCursor: true })).toBe("caught_up");
  });
  it("continues when the page straddles the watermark (out-of-order safe)", () => {
    expect(decideStop({ edge:"recent", pageTimestamps:[ts("2026-09-27T07:40:00Z"), ts("2026-09-27T08:30:00Z")],
      watermark: wm, skewMs: 600000, itemsSoFar: 25, maxItems: 500, hasNextCursor: true })).toBe("continue");
  });
  it("cap_reached takes priority over more pages", () => {
    expect(decideStop({ edge:"recent", pageTimestamps:[ts("2026-09-27T09:00:00Z")],
      watermark: wm, skewMs: 600000, itemsSoFar: 500, maxItems: 500, hasNextCursor: true })).toBe("cap_reached");
  });
  it("top edge never catches up, only cap or exhausted", () => {
    expect(decideStop({ edge:"top", pageTimestamps:[ts("2020-01-01T00:00:00Z")],
      watermark: null, skewMs: 600000, itemsSoFar: 25, maxItems: 500, hasNextCursor: false })).toBe("exhausted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write minimal implementation** — order of checks: cap (`itemsSoFar >= maxItems`) → for `recent` with a watermark, `caught_up` when `max(pageTimestamps) < watermark - skew` → `exhausted` when `!hasNextCursor` → else `continue`.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: watermark stop-condition logic

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-12: Sync service + outbox enqueue in one transaction (failure mode A + D-write-side)

**Files:**
- Create: `src/services/sync-service.ts`
- Test: `test/scenario/sync.test.ts`

**Interfaces:**
- Consumes: repos, `MetaClient`, `Clock`, `decideStop`, `mapMetaItem`, `Metrics`.
- Produces: `runSync(deps, job: { hashtagId: string; edge: "top"|"recent"; syncRunId?: string; cursor?: string|null }): Promise<{status:"SUCCESS"|"TRUNCATED"|"FAILED"; runId:string}>`. On each valid item it upserts media+hashtags+snapshot+assets and enqueues a `DOWNLOAD_ASSET` outbox row **in the same transaction as the media write**. On `cap_reached` it sets TRUNCATED, saves `resume_cursor`, and enqueues a follow-up `SYNC_HASHTAG_MEDIA` outbox row with `parent_run_id`.

- [ ] **Step 1: Write the failing tests** (the spec §7-A set)

```ts
// test/scenario/sync.test.ts (write each as its own it())
// - "hitting the 500 cap marks TRUNCATED, saves cursor, enqueues a follow-up"
// - "follow-up resumes from the saved cursor, stores all 700 across 28 pages, closes the gap"
// - "stops when a page is entirely older than watermark - skew"
// - "does not stop at the first already-seen id on an out-of-order page"
// - "a NUL caption on one item stores the other 24 and records one rejected item"
import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { ScriptedMetaClient, FakeClock, RecordingMetrics } from "../helpers/fakes.js";
import { runSync } from "../../src/services/sync-service.js";
// build pages with 28*25=700 items, cursor chained; assert media count + sync_runs row + outbox follow-up.
```

- [ ] **Step 2: Run tests to verify they fail** — FAIL.
- [ ] **Step 3: Write minimal implementation** — loop: create/resume run; fetch page via MetaClient; map each item (rejected → `rejectedRepo`); open a transaction, upsert everything + enqueue download outbox rows + update counters; call `decideStop`; on `cap_reached` finish TRUNCATED + save cursor + enqueue follow-up (with `parent_run_id`) + increment `sync_truncated_total`; on `caught_up`/`exhausted` finish SUCCESS and, if this run has a `parent_run_id`, mark the parent gap `closed`. Watermark from `syncRunRepo.latestWatermark(edge)` (follow-ups inherit the parent's `watermark_before`).
- [ ] **Step 4: Run tests to verify they pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sync service with watermark, 500-cap truncation, follow-up (failure A)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-13: SSRF guard + fetch downloader (failure mode B guard)

**Files:**
- Create: `src/domain/ssrf.ts`, `src/adapters/downloader/fetch-downloader.ts`, `src/adapters/dns/system-dns.ts`
- Test: `test/unit/ssrf.test.ts`, `test/integration/downloader.test.ts`

**Interfaces:**
- Consumes: `DnsResolver`, config allowlist.
- Produces: `isPrivateIp(ip: string): boolean` (v4+v6: private, loopback, link-local incl. `169.254.170.2`, CGNAT `100.64/10`, ULA `fc00::/7`); `hostAllowed(host: string, allowlist: string[]): boolean` (wildcard match); `guardedDownload(deps, url): Promise<DownloadResult>` — https only, host allowed, DNS resolved, every resolved IP public, connect to the checked IP, ≤3 manual redirects each re-checked, 30s timeout, size cap that aborts.

- [ ] **Step 1: Write the failing tests** (spec §13.2 set) — reject `http://`, off-allowlist host, host resolving to `10.x`, redirect to `127.0.0.1`, `169.254.170.2`; and a body over the cap aborts. Assert (via `FakeDns` + `FakeDownloader`) that **no socket opens to the bad target**.
- [ ] **Step 2: Run tests to verify they fail** — FAIL.
- [ ] **Step 3: Write minimal implementation** — `ssrf.ts` pure classifiers with unit tests; `fetch-downloader.ts` uses `undici` (bundled with Node) with a custom `lookup`/agent pinned to the pre-resolved IP, `redirect: "manual"`, `AbortController` timeout, and a streaming reader that counts bytes and aborts past `maxAssetBytes`.
- [ ] **Step 4: Run tests to verify they pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: SSRF guard and streaming guarded downloader (failure B guard)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-14: Disk storage adapter

**Files:**
- Create: `src/adapters/storage/disk-storage.ts`
- Test: `test/contract/blob-storage.contract.ts`, `test/integration/disk-storage.test.ts`

**Interfaces:**
- Consumes: `BlobStorage`.
- Produces: `DiskStorage(dir)` implementing `BlobStorage`; `getReadUrl(key)` → `/files/<key>`. A reusable `blobStorageContract(makeStorage)` suite that both `FakeStorage` and `DiskStorage` pass.

- [ ] **Step 1: Write the failing test** — contract: `put` then `exists` true; `getReadUrl` returns a `/files/` path; `put` is idempotent for the same key.
- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write minimal implementation** — write to `dir/<key>` via a temp file + atomic rename; `exists` via `fs.stat`; stream the async iterable to disk.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: disk blob storage + shared contract suite

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-15: Download service + repost linking (failure modes B + C)

**Files:**
- Create: `src/services/download-service.ts`, `src/services/repost-service.ts`
- Test: `test/scenario/download.test.ts`, `test/scenario/repost.test.ts`

**Interfaces:**
- Consumes: `assetRepo`, `mediaRepo`, `repost-service`, `BlobStorage`, `HttpDownloader`, `Clock`, `Metrics`.
- Produces: `runDownload(deps, job:{assetId:number}): Promise<void>`; `linkReposts(tx, mediaId): Promise<void>`. `runDownload` claims the asset (lease), guarded-downloads, hashes while streaming, `put`s under `sha256/<aa>/<hash>.<ext>` (skips if exists), then in one transaction marks `stored` and calls `linkReposts`. Errors map to statuses per spec §6.4.

- [ ] **Step 1: Write the failing tests** (spec §7-B and §7-C sets) — 403 → `url_expired` no retry; fresh url on next sync re-arms to pending and completes; never `stored` unless object exists and hash matches; carousel → one asset per child. Repost: identical bytes → linked `exact_bytes`, one object in storage; identical long caption+type → linked `caption`; short caption not linked; earlier-timestamp member becomes canonical; group totals equal member sums; repeated sync doesn't double count.
- [ ] **Step 2: Run tests to verify they fail** — FAIL.
- [ ] **Step 3: Write minimal implementation** — `runDownload` per §6.4 (file-type detect via `file-type`, allow image/video only). `linkReposts`: find exact-bytes original (same `content_sha256` on a position-0 asset, `duplicate_of_id IS NULL`) else caption match; create/join `repost_groups`, pick canonical by earliest `ig_timestamp`, set `duplicate_of_id`/`dup_reason`, recompute size/totals — all inside the caller's transaction.
- [ ] **Step 4: Run tests to verify they pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: download service and repost linking (failures B and C)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-16: Relay, sweeper, bootstrap/catch-up, workers (failure mode D recovery)

**Files:**
- Create: `src/services/relay.ts`, `src/services/sweeper.ts`, `src/services/bootstrap.ts`, `src/workers/sync-worker.ts`, `src/workers/download-worker.ts`
- Test: `test/scenario/durability.test.ts`

**Interfaces:**
- Consumes: `outboxRepo`, `assetRepo`, `syncRunRepo`, `Queue`, `Clock`.
- Produces: `runRelayOnce(deps)`, `runSweeperOnce(deps)`, `bootstrap(deps)` (hashtag search-once + catch-up enqueue), `SyncWorker`/`DownloadWorker` with `runOnce()` and `handleSigterm()`.

- [ ] **Step 1: Write the failing tests** (spec §7-D set) — crash after commit before enqueue → `runRelayOnce` publishes it; crash mid-download → lease expires → `runSweeperOnce` re-queues → exactly one object + one stored asset; same job twice → no duplicate rows/objects; missed cron window → `bootstrap` enqueues a sync when last success > 3h; lost queue message for a pending asset → sweeper re-queues.
- [ ] **Step 2: Run tests to verify they fail** — FAIL.
- [ ] **Step 3: Write minimal implementation** — relay: `claimBatch` → `queue.enqueue` → `markPublished` in a transaction. sweeper: re-queue `downloading` past lease and `pending` older than 5m with no unpublished outbox row; increment `sweeper_requeued_total`. bootstrap: `searchHashtag` only when `ig_hashtag_id` absent; catch-up per edge. workers: `receive` → run service → `ack`; on failure `release` with backoff.
- [ ] **Step 4: Run tests to verify they pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: relay, sweeper, bootstrap, workers (failure D recovery)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-17: Cursor signing + `GET /hashtags` + `/files` + Express app

**Files:**
- Create: `src/domain/cursor.ts`, `src/http/app.ts`, `src/http/routes/hashtags.ts`, `src/http/routes/files.ts`
- Test: `test/unit/cursor.test.ts`, `test/http/hashtags.test.ts`

**Interfaces:**
- Consumes: `mediaRepo` (add `feedPage(afterCursor, limit)`), `BlobStorage`, config.
- Produces: `encodeCursor/decodeCursor` (HMAC-signed `{t,id,kid}`, multi-key verify); the Express `createApp(deps)` factory; `GET /hashtags` and `GET /files/:key`.

- [ ] **Step 1: Write the failing tests** (spec §9 set + cursor unit) — cursor round-trips and rejects a tampered/foreign-kid cursor; feed excludes reposts, orders by `ig_timestamp DESC,id DESC`; `limit` clamped to 100; new posts between page 1 and 2 cause no dup/skip; a post inserted later with an older timestamp sorts lower; a rotated-out key is rejected.
- [ ] **Step 2: Run tests to verify they fail** — FAIL.
- [ ] **Step 3: Write minimal implementation** — `cursor.ts` with `crypto.createHmac`, base64url, constant-time compare, verify against every configured key, sign with the first. `feedPage` keyset query `WHERE duplicate_of_id IS NULL AND (ig_timestamp,id) < (?,?)`. Route builds `data`/`pageInfo`, resolves asset `url` via `getReadUrl` only for `stored`, sets `X-Request-Id` + `nosniff`, returns 400 on bad cursor, 404 on unknown tag. `/files/:key` streams from storage with `nosniff` + `Content-Disposition: attachment`.
- [ ] **Step 4: Run tests to verify they pass** — PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: signed keyset cursors and GET /hashtags + /files

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task P1-18: Wiring, role selection, node-cron, graceful shutdown, instructions.md, secret-leak test

**Files:**
- Create: `src/adapters/scheduler/node-cron-scheduler.ts`, `src/adapters/meta/http-meta-client.ts`, `src/adapters/secrets/env-secret-provider.ts`, `src/index.ts` (real), `instructions.md`, `test/unit/no-secrets.test.ts`, `test/contract/meta-client.contract.ts`
- Test: `test/integration/wiring.test.ts`, `test/unit/no-secrets.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable app (`APP_ROLES`-selected), the real `HttpMetaClient` (records fixtures), the leak-scan test, and `instructions.md` with `setup`, `vars`, `tradeoffs`, `ai-usage` (plus `production`, `runbooks` stubs to fill in P2/P4).

- [ ] **Step 1: Write the failing tests** — `no-secrets.test.ts`: walk all git-tracked files + `test/fixtures/**` and assert none contains `access_token=` or `/EAA[A-Za-z0-9]{20,}/`. `wiring.test.ts`: `createApp` with fakes boots and `/hashtags` responds 200 with an empty feed.
- [ ] **Step 2: Run tests to verify they fail** — FAIL.
- [ ] **Step 3: Write minimal implementation** — `index.ts`: load config, build a `SecretProvider` (env), read secrets, construct adapters, select components by `APP_ROLES`, start cron/relay/sweeper loops, register SIGTERM → stop intake, drain up to `SHUTDOWN_GRACE_MS`, release leases, exit 0. `HttpMetaClient`: build URLs (fields per §8), apply `appsecret_proof` when app secret present, wrap errors so the URL never reaches the message (use `sanitizeUrl`), map error codes to typed errors, read usage headers. `node-cron-scheduler`: `cron.schedule(SYNC_INTERVAL_CRON, enqueue both edges)`. `env-secret-provider`: read from config/process env. `instructions.md`: real `setup` (compose up, migrate, dev), `vars` table (§17), `tradeoffs` (§3 out-of-scope + known repost/limits), `ai-usage`.
- [ ] **Step 4: Run tests to verify they pass** — PASS. Then a manual smoke: `docker compose up -d && npm run migrate && npm run dev`, confirm bootstrap logs a hashtag id and `GET /hashtags` responds.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: app wiring, cron, http meta client, shutdown, instructions, leak test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 1 Definition of Done

- All P1 tests pass; `npm run typecheck` clean.
- The brief's checklist is met: Express+TS+Postgres, migrations, tracks `matcha`, top media once + recent every 3h, metadata stored, assets downloaded to storage, duplicates avoided (incl. reposts hidden), `GET /hashtags` paginated in descending creation-time order.
- Failure modes A–D each have passing named tests.
- No secret in any tracked file or fixture.
- `instructions.md` has `setup`, `vars`, `tradeoffs`, `ai-usage`.

**At this point the submission is viable.** P2–P4 harden and extend it.

---

## Phase 2–4 Outlines (expand to full-detail tasks before executing each phase)

### Phase 2: Hardening
- **P2-01 Meta throttle + backoff:** `backoff.ts` (tested pure), throttle inside `HttpMetaClient` reading usage headers (≥80% space out, 100% pause to reset); error taxonomy (rate/temporary/fatal); 190 → re-fetch secret once then fail; delays >15m via `outbox.available_at`. Tests: spec §8.
- **P2-02 REST rate limiting:** token-bucket middleware behind `RateLimitStore` (in-memory), `TRUST_PROXY` hop count, 429 + `Retry-After` + `RateLimit-*`. Tests: spec §9 rate-limit + §13.3 XFF.
- **P2-03 Metrics adapter:** `prom-metrics.ts`, `/metrics` on `METRICS_PORT`, wire counters/gauges/histograms named in §12.2 into existing services.
- **P2-04 Watchdog + alerts + health:** `alerts` table dedup, `AlertSink` log/Slack, watchdog rules (§12.4), `/healthz`,`/readyz`,`/internal/status`. Tests: spec §12.4 set (fake clock).
- **P2-05 Retention + delete + SLO calculator:** retention job (§6.8), `DELETE /internal/media/:id`, SLO calculator over `sync_runs` + burn-rate alerts. Tests: spec §14.
- **P2-06 Adaptive interval + unrecoverable-gap detection:** extra sync after 2 truncations; watchdog marks gaps unrecoverable > 24h. Tests: spec §7-A remaining.

### Phase 3: Dashboard
- **P3-01 API keys:** `api_keys` repo, `dash_<keyId>_<secret>` format, sha256 storage, constant-time verify with dummy-hash path, scopes, CLI create/revoke, `last_used_at` throttle. Tests: spec §11.
- **P3-02 Read pool + ReadDb:** `tracker_graphql` pool, 2s `statement_timeout`, separate from ingestion pool. Tests: role cannot INSERT; saturation doesn't starve sync.
- **P3-03 GraphQL schema + resolvers + DataLoader:** yoga server, schema (§10), loaders (≤3 SQL for 50 posts), bucketed `engagementHistory`, `repostGroup`. Tests: spec §10 N+1, correctness, consistency-with-REST.
- **P3-04 Query limits + cost + cache + cost-rate-limit:** graphql-armor depth/alias/cost, persisted-op allowlist in prod, 30s LRU cache cleared on sync finish, per-key cost budget, introspection off + masked errors. Tests: spec §10 limits + cache.

### Phase 4: Production
- **P4-01 AWS adapters:** `adapters/aws/{sqs-queue,s3-storage,secrets-manager-provider,eventbridge-scheduler,cloudwatch-metrics,sns-alert-sink}.ts`; each passes its interface's contract suite. `SecretProvider` AWS with 5m cache + prod "no env secrets" enforced end-to-end.
- **P4-02 Graceful shutdown hardening + migration-compat CI:** verify SIGTERM drain against Fargate `stopTimeout`; CI job runs the previous release's tests against the new schema.
- **P4-03 Pulumi stack:** `infra/` with ECS Fargate services (§15.1), RDS, S3, SQS, EventBridge, Secrets Manager (created empty), VPC + Network Firewall egress allowlist, WAF. `setMocks` unit tests (§15.4) + CrossGuard policy pack.
- **P4-04 Production docs:** fill `instructions.md` `production` + `runbooks` (one per alert key, §12.4), leak runbook (§15.5), scale notes (§15.6).

---

## Self-Review

**Spec coverage:** §4 interfaces → P1-09; §5 schema+roles → P1-04/05; §6.2 sync/A → P1-12; §6.4 download/B → P1-15; §6.5 repost/C → P1-15; §6.3/6.7/6.9 durability/D → P1-16; §6.6 validation → P1-08; §9 REST → P1-17; §13.1 secrets rule → P1-02/P1-18; §13.2 SSRF → P1-13; §8 throttle → P2-01; §9 rate limit → P2-02; §12 observability → P2-03/04/05; §14 SLO → P2-05; §10 GraphQL → P3; §11 API keys → P3-01; §15 production → P4. All spec sections map to a task.

**Placeholder scan:** P1 tasks contain concrete code/commands. P2–P4 are explicitly outlines to be expanded before execution (stated at top), not executed as-is — this is intentional, not a placeholder in executable work.

**Type consistency:** interface names in P1-09 (`Queue.enqueue/receive/ack/release`, `BlobStorage.put/exists/getReadUrl`, `MetaClient.searchHashtag/media/debugToken`) are used unchanged in P1-10/12/15/16/17/18. `MappedMedia`/`AssetInput` from P1-08 are consumed by P1-10/12. `decideStop` signature (P1-11) matches its use in P1-12.
