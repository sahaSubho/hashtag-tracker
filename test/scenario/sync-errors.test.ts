import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, RecordingMetrics, ScriptedMetaClient } from "../helpers/fakes.js";
import { runSync, type SyncJobInput } from "../../src/services/sync-service.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import { MetaApiError } from "../../src/adapters/meta/http-meta-client.js";
import type { MetaClient, MetaPage } from "../../src/ports/meta-client.js";

const HASHTAG_ID = "17843";

class OneShotErrorMetaClient implements MetaClient {
  public calls = 0;
  public requestedCursors: (string | null)[] = [];
  constructor(private readonly error: MetaApiError) {}

  async searchHashtag() {
    return HASHTAG_ID;
  }

  async media(_edge: "top" | "recent", _hashtagId: string, cursor: string | null): Promise<MetaPage> {
    this.calls++;
    this.requestedCursors.push(cursor);
    throw this.error;
  }

  async debugToken() {
    return { expiresAt: null, scopes: [], valid: true };
  }
}

const baseDeps = (meta: MetaClient, overrides = {}) => ({
  meta,
  syncMaxItems: 500,
  syncSkewMinutes: 10,
  clock: new FakeClock(new Date("2026-09-27T12:00:00Z")),
  metrics: new RecordingMetrics(),
  maxTemporaryRetries: 5,
  ...overrides,
});

describe("runSync — Meta error handling (spec §8)", () => {
  it("a fatal error (token invalid) fails the run immediately with no retry, no outbox row", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const meta = new OneShotErrorMetaClient(new MetaApiError(190, "invalid token"));
      const deps = { ...baseDeps(meta), db };

      const result = await runSync(deps, { hashtagId: hashtag.id, edge: "recent" });

      expect(result.status).toBe("FAILED");
      expect(meta.calls).toBe(1);
      const run = await db.selectFrom("sync_runs").selectAll().where("id", "=", result.runId).executeTakeFirstOrThrow();
      expect(run.error_code).toBe("190");

      const outboxRows = await db.selectFrom("outbox").selectAll().where("kind", "=", "SYNC_HASHTAG_MEDIA").execute();
      expect(outboxRows.length).toBe(0);
    });
  });

  it("a rate-limit error saves the cursor and re-enqueues with a delay; the run stays RUNNING", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const meta = new OneShotErrorMetaClient(new MetaApiError(4, "rate limited"));
      const deps = { ...baseDeps(meta), db };

      const result = await runSync(deps, {
        hashtagId: hashtag.id,
        edge: "recent",
        cursor: "resume-here",
      });

      expect(result.status).toBe("RUNNING");
      const outboxRows = await db
        .selectFrom("outbox")
        .selectAll()
        .where("kind", "=", "SYNC_HASHTAG_MEDIA")
        .execute();
      expect(outboxRows.length).toBe(1);
      const payload = outboxRows[0]!.payload as { cursor: string; hashtagId: number; edge: string };
      expect(payload.cursor).toBe("resume-here");
      expect(payload.hashtagId).toBe(hashtag.id);
      expect(payload.edge).toBe("recent");
      expect(new Date(outboxRows[0]!.available_at).getTime()).toBeGreaterThan(baseDeps(meta).clock.now().getTime());
    });
  });

  it("a temporary error saves the cursor, re-enqueues with backoff, and stays RUNNING for the first N attempts", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const meta = new OneShotErrorMetaClient(new MetaApiError(2, "server error"));
      const deps = { ...baseDeps(meta, { maxTemporaryRetries: 3 }), db };

      const result = await runSync(deps, { hashtagId: hashtag.id, edge: "recent" });

      expect(result.status).toBe("RUNNING");
      const run = await db.selectFrom("sync_runs").selectAll().where("id", "=", result.runId).executeTakeFirstOrThrow();
      // The last error is recorded for operators to see, but finished_at
      // stays unset — the run has not actually finished, only paused.
      expect(run.error_code).toBe("2");
      expect(run.finished_at).toBeNull();
      const outboxRows = await db.selectFrom("outbox").selectAll().where("kind", "=", "SYNC_HASHTAG_MEDIA").execute();
      expect(outboxRows.length).toBe(1);
    });
  });

  it("a temporary error exhausts its retry budget and the run is marked FAILED with no further retry", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const meta = new OneShotErrorMetaClient(new MetaApiError(2, "server error"));
      const deps = { ...baseDeps(meta, { maxTemporaryRetries: 3 }), db };

      // Simulate 3 prior temporary-error retries already having happened:
      // a paused RUNNING run, resumed by a retry job at attempt count 3.
      const run = await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));
      await db
        .transaction()
        .execute((tx) => syncRunRepo.finish(tx, run.id, { status: "RUNNING", errorCode: "2" }));

      const result = await runSync(deps, {
        hashtagId: hashtag.id,
        edge: "recent",
        resumeRunId: run.id,
        temporaryAttempt: 3,
      });

      expect(result).toEqual({ status: "FAILED", runId: run.id });
      expect(await db.selectFrom("sync_runs").select("status").execute()).toEqual([{ status: "FAILED" }]);
      const outboxRows = await db.selectFrom("outbox").selectAll().where("kind", "=", "SYNC_HASHTAG_MEDIA").execute();
      expect(outboxRows.length).toBe(0);
    });
  });
});

function item(id: string, isoTimestamp: string) {
  return {
    id,
    media_type: "IMAGE",
    permalink: `https://instagram.com/p/${id}`,
    timestamp: isoTimestamp,
    media_url: `https://x.fbcdn.net/${id}.jpg`,
    caption: `post ${id}`,
    like_count: 1,
    comments_count: 0,
  };
}

/** `count` items one minute apart, newest first, in pages of 25. */
function pagesOf(count: number, newest: Date): MetaPage[] {
  const items = Array.from({ length: count }, (_, i) => item(`m${i}`, new Date(newest.getTime() - i * 60000).toISOString()));
  const pages: MetaPage[] = [];
  for (let i = 0; i < items.length; i += 25) {
    pages.push({ items: items.slice(i, i + 25), nextCursor: i + 25 >= items.length ? null : `cursor_${i + 25}`, usagePct: null });
  }
  return pages;
}

/** Scripted pages, but the call at `failOnCall` (1-based) throws `error` once. */
function metaFailingOnce(pages: MetaPage[], failOnCall: number, error: MetaApiError) {
  const meta = new ScriptedMetaClient({ hashtagId: HASHTAG_ID, pagesByEdge: { recent: pages } });
  let calls = 0;
  meta.onMedia = () => {
    calls++;
    if (calls === failOnCall) throw error;
  };
  return meta;
}

async function pendingRetryJob(db: any): Promise<SyncJobInput> {
  const rows = await db.selectFrom("outbox").selectAll().where("kind", "=", "SYNC_HASHTAG_MEDIA").where("published_at", "is", null).execute();
  expect(rows.length).toBe(1);
  return rows[0].payload as SyncJobInput;
}

/**
 * Found on a live run: every retry created a NEW sync_runs row and the
 * paused one stayed RUNNING forever — which also made the watchdog's
 * sync_overdue check (it reads the newest RUNNING row) fire falsely.
 * A retry now resumes and finishes the same row.
 */
describe("runSync — resuming a paused run", () => {
  const newest = new Date("2026-09-27T11:59:00Z");

  for (const [label, error] of [
    ["temporary", new MetaApiError(2, "server error")],
    ["rate-limit", new MetaApiError(4, "rate limited")],
  ] as const) {
    it(`after a ${label} error, the retry finishes the SAME run row, with counters and newest_seen_ts carried over`, async () => {
      await withTestDb(async (db) => {
        const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
        const deps = { ...baseDeps(metaFailingOnce(pagesOf(75, newest), 2, error)), db };

        const first = await runSync(deps, { hashtagId: hashtag.id, edge: "recent" });
        expect(first.status).toBe("RUNNING");

        const retry = await runSync(deps, await pendingRetryJob(db));

        expect(retry).toEqual({ status: "SUCCESS", runId: first.runId });
        const runs = await db.selectFrom("sync_runs").selectAll().execute();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: "SUCCESS", pages: 3, items_fetched: 75, items_new: 75, error_code: null });
        expect(runs[0]!.finished_at).not.toBeNull();
        expect(runs[0]!.newest_seen_ts).toEqual(newest);
      });
    });
  }

  it("a duplicate delivery of an already-finished retry is a no-op (no new run, no Meta calls)", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      const meta = metaFailingOnce(pagesOf(50, newest), 2, new MetaApiError(2, "server error"));
      const deps = { ...baseDeps(meta), db };

      const first = await runSync(deps, { hashtagId: hashtag.id, edge: "recent" });
      const job = await pendingRetryJob(db);
      await runSync(deps, job);
      const callsBefore = meta.requestedCursors.length;

      const again = await runSync(deps, job);

      expect(again).toEqual({ status: "SUCCESS", runId: first.runId });
      expect(meta.requestedCursors.length).toBe(callsBefore);
      expect(await db.selectFrom("sync_runs").selectAll().execute()).toHaveLength(1);
    });
  });

  it("items fetched before the pause still count toward the item cap", async () => {
    await withTestDb(async (db) => {
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", HASHTAG_ID);
      // 520 items; fail on page 11, after 250 items are in.
      const deps = { ...baseDeps(metaFailingOnce(pagesOf(520, newest), 11, new MetaApiError(2, "server error"))), db };

      await runSync(deps, { hashtagId: hashtag.id, edge: "recent" });
      const retry = await runSync(deps, await pendingRetryJob(db));

      expect(retry.status).toBe("TRUNCATED");
      const run = await db.selectFrom("sync_runs").selectAll().where("id", "=", retry.runId).executeTakeFirstOrThrow();
      expect(run.items_fetched).toBe(500);
    });
  });
});
