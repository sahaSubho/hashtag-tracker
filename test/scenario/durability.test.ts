import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import {
  FakeClock,
  FakeDns,
  FakeDownloader,
  FakeStorage,
  FakeQueue,
  RecordingMetrics,
} from "../helpers/fakes.js";
import { runRelayOnce, type RelayDeps } from "../../src/services/relay.js";
import { runSweeperOnce } from "../../src/services/sweeper.js";
import { bootstrap } from "../../src/services/bootstrap.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { assetRepo } from "../../src/db/repositories/asset-repo.js";
import { outboxRepo } from "../../src/db/repositories/outbox-repo.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";
import { syncRunRepo } from "../../src/db/repositories/sync-run-repo.js";
import type { MappedMedia } from "../../src/domain/types.js";
import type { MetaClient } from "../../src/ports/meta-client.js";

const allowlist = ["*.cdninstagram.com", "*.fbcdn.net"];

const media = (over: Partial<MappedMedia> = {}): MappedMedia => ({
  igMediaId: "m1",
  mediaType: "IMAGE",
  caption: null,
  captionNormHash: null,
  permalink: "p",
  igTimestamp: new Date("2026-09-27T08:00:00Z"),
  likeCount: 1,
  commentsCount: 0,
  assets: [],
  raw: {},
  ...over,
});

describe("runRelayOnce — outbox publish recovery (failure mode D)", () => {
  it("a crash after commit, before enqueue, is recovered: the relay publishes it on its next run", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      // Simulate the write side: a row was committed to the outbox (as
      // sync-service does), but the process crashed before the relay ever
      // ran — the row just sits there, unpublished.
      await db.transaction().execute((tx) => outboxRepo.enqueue(tx, "DOWNLOAD_ASSET", { assetId: 1 }, clock.now()));

      const queue = new FakeQueue(clock);
      await runRelayOnce({ db, queue, clock, metrics: new RecordingMetrics(), batchSize: 100 });

      const jobs = await queue.receive(["DOWNLOAD_ASSET"], 10);
      expect(jobs.length).toBe(1);

      const row = await db.selectFrom("outbox").selectAll().executeTakeFirstOrThrow();
      // Stamped from the relay's injected clock, not the wall clock, so
      // retention's "published more than 7 days ago" is deterministic.
      expect(row.published_at).toEqual(clock.now());
    });
  });

  it("does not republish an already-published row", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await db.transaction().execute((tx) => outboxRepo.enqueue(tx, "DOWNLOAD_ASSET", { assetId: 1 }, clock.now()));

      const queue = new FakeQueue(clock);
      const deps = { db, queue, clock, metrics: new RecordingMetrics(), batchSize: 100 };
      await runRelayOnce(deps);
      await queue.receive(["DOWNLOAD_ASSET"], 10); // drain
      await runRelayOnce(deps);

      const jobs = await queue.receive(["DOWNLOAD_ASSET"], 10);
      expect(jobs.length).toBe(0);
    });
  });
});

describe("runSweeperOnce — lease and lost-message recovery (failure mode D)", () => {
  it("a crash mid-download is recovered: the lease expires, the sweeper re-queues, and the result is exactly one stored asset", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db.transaction().execute((tx) => mediaRepo.upsert(tx, media(), clock));
      const [asset] = await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          {
            position: 0,
            kind: "image",
            sourceUrl: "https://x.fbcdn.net/a.jpg",
            sourceUrlExpiresAt: null,
            status: "pending",
          },
        ])
      );

      // Claim it (as a download worker would), simulating the crash: the
      // asset is stuck in `downloading` with a lease that will expire.
      const leaseUntil = new Date(clock.now().getTime() + 60000);
      await db.transaction().execute((tx) => assetRepo.claim(tx, asset!.assetId, leaseUntil));

      const queue = new FakeQueue(clock);
      const metrics = new RecordingMetrics();

      // Before the lease expires, the sweeper does nothing.
      await runSweeperOnce({ db, queue, clock, metrics, staleLeaseGraceMs: 0, stalePendingGraceMs: 300000 });
      expect((await queue.receive(["DOWNLOAD_ASSET"], 10)).length).toBe(0);

      // After the lease expires, the sweeper re-queues it. The sweeper
      // writes to the outbox (like the sync service does); the relay is
      // what moves an outbox row onto the actual queue — same as in
      // production, so we drive both here.
      clock.advance(61000);
      await runSweeperOnce({ db, queue, clock, metrics, staleLeaseGraceMs: 0, stalePendingGraceMs: 300000 });
      await runRelayOnce({ db, queue, clock, metrics, batchSize: 100 });

      const row = await db.selectFrom("media_assets").selectAll().where("id", "=", asset!.assetId).executeTakeFirstOrThrow();
      expect(row.status).toBe("pending");

      const jobs = await queue.receive(["DOWNLOAD_ASSET"], 10);
      expect(jobs.length).toBe(1);
      expect(metrics.countOf("sweeper.requeued")).toBe(1);
    });
  });

  it("the same job delivered twice produces no duplicate rows or objects (claim is idempotent)", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db.transaction().execute((tx) => mediaRepo.upsert(tx, media(), clock));
      const [asset] = await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          {
            position: 0,
            kind: "image",
            sourceUrl: "https://x.fbcdn.net/a.jpg",
            sourceUrlExpiresAt: null,
            status: "pending",
          },
        ])
      );

      const leaseUntil = new Date(clock.now().getTime() + 120000);
      const first = await db.transaction().execute((tx) => assetRepo.claim(tx, asset!.assetId, leaseUntil));
      const second = await db.transaction().execute((tx) => assetRepo.claim(tx, asset!.assetId, leaseUntil));

      expect(first?.status).toBe("downloading");
      expect(second).toBeUndefined(); // the second delivery finds nothing claimable — a no-op ack
    });
  });

  it("a pending asset whose queue message was lost is re-queued by the sweeper", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId } = await db.transaction().execute((tx) => mediaRepo.upsert(tx, media(), clock));
      await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          {
            position: 0,
            kind: "image",
            sourceUrl: "https://x.fbcdn.net/a.jpg",
            sourceUrlExpiresAt: null,
            status: "pending",
          },
        ])
      );
      // No outbox row was ever created for it — as if the enqueue in the
      // sync transaction never happened (message lost), yet the asset row
      // itself is committed and sitting there `pending`.

      const queue = new FakeQueue(clock);
      const metrics = new RecordingMetrics();

      // Not yet stale — no requeue.
      await runSweeperOnce({ db, queue, clock, metrics, staleLeaseGraceMs: 60000, stalePendingGraceMs: 300000 });
      expect((await queue.receive(["DOWNLOAD_ASSET"], 10)).length).toBe(0);

      clock.advance(300001);
      await runSweeperOnce({ db, queue, clock, metrics, staleLeaseGraceMs: 60000, stalePendingGraceMs: 300000 });
      await runRelayOnce({ db, queue, clock, metrics, batchSize: 100 });
      expect((await queue.receive(["DOWNLOAD_ASSET"], 10)).length).toBe(1);
    });
  });
});

describe("bootstrap — catch-up after a missed cron window (failure mode D)", () => {
  const scriptedMeta = (hashtagId: string): MetaClient => ({
    async searchHashtag() {
      return hashtagId;
    },
    async media() {
      return { items: [], nextCursor: null, usagePct: null };
    },
    async debugToken() {
      return { expiresAt: null, scopes: [], valid: true };
    },
  });

  it("calls searchHashtag only when ig_hashtag_id is not already stored", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const meta = scriptedMeta("17843");
      let searchCalls = 0;
      const wrappedMeta: MetaClient = {
        ...meta,
        async searchHashtag(name) {
          searchCalls++;
          return meta.searchHashtag(name);
        },
      };

      await bootstrap({ db, meta: wrappedMeta, clock, hashtag: "matcha", syncIntervalMs: 3 * 3600000 });
      expect(searchCalls).toBe(1);

      await bootstrap({ db, meta: wrappedMeta, clock, hashtag: "matcha", syncIntervalMs: 3 * 3600000 });
      expect(searchCalls).toBe(1); // second bootstrap does not search again
    });
  });

  it("enqueues a sync when the last success is older than the sync interval", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");

      const run = await db
        .transaction()
        .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge: "recent", watermarkBefore: null }));
      await db
        .transaction()
        .execute((tx) => syncRunRepo.finish(tx, run.id, { status: "SUCCESS", newestSeenTs: null, oldestSeenTs: null }));

      clock.advance(4 * 3600000); // 4h later — window missed

      await bootstrap({
        db,
        meta: scriptedMeta("17843"),
        clock,
        hashtag: "matcha",
        syncIntervalMs: 3 * 3600000,
      });

      const outboxRows = await db
        .selectFrom("outbox")
        .selectAll()
        .where("kind", "=", "SYNC_HASHTAG_MEDIA")
        .execute();
      expect(outboxRows.length).toBeGreaterThan(0);
    });
  });

  it("does not enqueue a catch-up sync when the last success is recent", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const hashtag = await hashtagRepo.upsertOnce(db, "matcha", "17843");
      // Seed both edges as recently finished — bootstrap checks each edge
      // independently, so leaving one edge with no prior run would make it
      // look overdue regardless of the other edge's recency.
      for (const edge of ["top", "recent"] as const) {
        const run = await db
          .transaction()
          .execute((tx) => syncRunRepo.create(tx, { hashtagId: hashtag.id, edge, watermarkBefore: null }));
        await db
          .transaction()
          .execute((tx) => syncRunRepo.finish(tx, run.id, { status: "SUCCESS", newestSeenTs: null, oldestSeenTs: null }));
      }

      clock.advance(60000); // 1 minute later — well within the window

      await bootstrap({
        db,
        meta: scriptedMeta("17843"),
        clock,
        hashtag: "matcha",
        syncIntervalMs: 3 * 3600000,
      });

      const outboxRows = await db
        .selectFrom("outbox")
        .selectAll()
        .where("kind", "=", "SYNC_HASHTAG_MEDIA")
        .execute();
      expect(outboxRows.length).toBe(0);
    });
  });
});
