import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, RecordingMetrics, FakeQueue, FakeDns, FakeDownloader, FakeStorage } from "../helpers/fakes.js";
import { DownloadWorker } from "../../src/workers/download-worker.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { assetRepo } from "../../src/db/repositories/asset-repo.js";
import type { MappedMedia } from "../../src/domain/types.js";

const media = (over: Partial<MappedMedia> = {}): MappedMedia => ({
  igMediaId: "m1",
  mediaType: "IMAGE",
  caption: null,
  captionNormHash: null,
  permalink: "p",
  igTimestamp: new Date("2026-09-28T08:00:00Z"),
  likeCount: 1,
  commentsCount: 0,
  assets: [],
  raw: {},
  ...over,
});

function baseDownloadDeps(clock: FakeClock, overrides: Record<string, unknown> = {}) {
  return {
    dns: new FakeDns({ "x.fbcdn.net": ["157.240.2.35"] }),
    storage: new FakeStorage(),
    clock,
    hostAllowlist: ["*.fbcdn.net"],
    maxBytes: 100000,
    downloadLeaseSeconds: 120,
    downloadMaxAttempts: 5,
    ...overrides,
  };
}

describe("DownloadWorker", () => {
  it("acks the queue job on a successful download", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-28T09:00:00Z"));
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media(), clock));
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

      const downloader = new FakeDownloader({
        "https://x.fbcdn.net/a.jpg": {
          status: 200,
          headers: { "content-type": "image/jpeg" },
          bodyChunks: [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])],
        },
      });

      const queue = new FakeQueue(clock);
      await queue.enqueue("DOWNLOAD_ASSET", { assetId: asset!.assetId });

      const worker = new DownloadWorker({
        queue,
        metrics: new RecordingMetrics(),
        concurrency: 5,
        downloadDeps: { db, downloader, ...baseDownloadDeps(clock) },
      });

      const handled = await worker.runOnce();
      expect(handled).toBe(1);
      expect(await queue.receive(["DOWNLOAD_ASSET"], 10)).toHaveLength(0);

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", asset!.assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("stored");
    });
  });

  it("releases the job with a delay when runDownload throws (not one of its own handled failure paths)", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-28T09:00:00Z"));
      const downloader = new FakeDownloader({});
      const queue = new FakeQueue(clock);
      // runDownload catches and gracefully handles a claim miss, a missing
      // source_url, and every download/SSRF/file-type failure it can name
      // (spec §6.4) — none of those reject, they resolve after writing a
      // status. To exercise the worker's own catch-and-release path we
      // need a failure OUTSIDE that handled scope: a non-numeric assetId
      // makes assetRepo.claim's `WHERE id = $1` comparison a Postgres type
      // error, which is a realistic case (a corrupted/malformed queue
      // message) that genuinely rejects.
      await queue.enqueue("DOWNLOAD_ASSET", { assetId: "not-a-number" });

      const metrics = new RecordingMetrics();
      const worker = new DownloadWorker({
        queue,
        metrics,
        concurrency: 5,
        downloadDeps: { db, downloader, ...baseDownloadDeps(clock) },
      });

      await worker.runOnce();
      expect(metrics.countOf("download.job_failed")).toBe(1);
      expect(await queue.receive(["DOWNLOAD_ASSET"], 10)).toHaveLength(0);
      clock.advance(30000);
      expect(await queue.receive(["DOWNLOAD_ASSET"], 10)).toHaveLength(1);
    });
  });

  it("handleSigterm() stops runOnce from picking up new jobs; the job is left untouched for the next worker", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-28T09:00:00Z"));
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media(), clock));
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

      const downloader = new FakeDownloader({});
      const queue = new FakeQueue(clock);
      await queue.enqueue("DOWNLOAD_ASSET", { assetId: asset!.assetId });

      const worker = new DownloadWorker({
        queue,
        metrics: new RecordingMetrics(),
        concurrency: 5,
        downloadDeps: { db, downloader, ...baseDownloadDeps(clock) },
      });

      worker.handleSigterm();
      expect(worker.isRunning()).toBe(false);

      const handled = await worker.runOnce();
      expect(handled).toBe(0);
      expect(await queue.receive(["DOWNLOAD_ASSET"], 10)).toHaveLength(1);

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", asset!.assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("pending"); // untouched, not stuck claimed
    });
  });
});
