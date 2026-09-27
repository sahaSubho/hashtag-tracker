import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, RecordingMetrics } from "../helpers/fakes.js";
import { runSync } from "../../src/services/sync-service.js";
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

      // Simulate 3 prior temporary-error retries already having happened by
      // resuming with parentRunId chained; simplest here is to directly
      // create a run at attempt count 3 and resume from it.
      const run = await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));
      await db
        .transaction()
        .execute((tx) => syncRunRepo.finish(tx, run.id, { status: "RUNNING", errorCode: "2" }));

      const result = await runSync(deps, {
        hashtagId: hashtag.id,
        edge: "recent",
        parentRunId: run.id,
        temporaryAttempt: 3,
      } as any);

      expect(result.status).toBe("FAILED");
      const outboxRows = await db.selectFrom("outbox").selectAll().where("kind", "=", "SYNC_HASHTAG_MEDIA").execute();
      expect(outboxRows.length).toBe(0);
    });
  });
});
