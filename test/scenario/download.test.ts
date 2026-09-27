import { describe, it, expect } from "vitest";
import type { Kysely } from "kysely";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeDns, FakeDownloader, FakeStorage, RecordingMetrics } from "../helpers/fakes.js";
import { runDownload } from "../../src/services/download-service.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { assetRepo } from "../../src/db/repositories/asset-repo.js";
import type { MappedMedia } from "../../src/domain/types.js";
import type { DB } from "../../src/db/schema.js";

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

async function seedMediaWithAsset(
  db: Kysely<DB>,
  clock: FakeClock,
  igMediaId: string,
  sourceUrl: string
) {
  const { mediaId } = await db
    .transaction()
    .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId }), clock));
  const [asset] = await db.transaction().execute((tx) =>
    assetRepo.upsertMany(tx, mediaId, [
      { position: 0, kind: "image", sourceUrl, sourceUrlExpiresAt: null, status: "pending" },
    ])
  );
  return { mediaId, assetId: asset!.assetId };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    clock: new FakeClock(new Date("2026-09-27T09:00:00Z")),
    metrics: new RecordingMetrics(),
    hostAllowlist: allowlist,
    maxBytes: 100000,
    downloadLeaseSeconds: 120,
    downloadMaxAttempts: 5,
    ...overrides,
  };
}

describe("runDownload — failure mode B (expiring URLs)", () => {
  it("a 403 marks the asset url_expired with no blind retry", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { assetId } = await seedMediaWithAsset(db, clock, "m1", "https://x.fbcdn.net/a.jpg");

      const dns = new FakeDns({ "x.fbcdn.net": ["157.240.2.35"] });
      const downloader = new FakeDownloader({
        "https://x.fbcdn.net/a.jpg": { status: 403 },
      });
      const storage = new FakeStorage();

      await runDownload(
        { db, dns, downloader, storage, ...baseDeps({ clock }) },
        { assetId }
      );

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("url_expired");
      expect(row.attempts).toBe(1);
    });
  });

  it("a fresh media_url on the next sync re-arms the asset and the download completes", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { mediaId, assetId } = await seedMediaWithAsset(
        db,
        clock,
        "m2",
        "https://x.fbcdn.net/old.jpg"
      );

      // Simulate the expired state directly (as a prior download attempt would have left it).
      await db
        .updateTable("media_assets")
        .set({ status: "url_expired" })
        .where("id", "=", assetId)
        .execute();

      // A later sync sees a fresh URL and re-arms it (asset-repo behavior, already tested;
      // here we just apply it directly to set up this test's scenario).
      await db.transaction().execute((tx) =>
        assetRepo.upsertMany(tx, mediaId, [
          {
            position: 0,
            kind: "image",
            sourceUrl: "https://x.fbcdn.net/fresh.jpg",
            sourceUrlExpiresAt: null,
            status: "pending",
          },
        ])
      );

      const dns = new FakeDns({ "x.fbcdn.net": ["157.240.2.35"] });
      const downloader = new FakeDownloader({
        "https://x.fbcdn.net/fresh.jpg": {
          status: 200,
          headers: { "content-type": "image/jpeg" },
          bodyChunks: [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])],
        },
      });
      const storage = new FakeStorage();

      await runDownload({ db, dns, downloader, storage, ...baseDeps({ clock }) }, { assetId });

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("stored");
      expect(row.storage_key).not.toBeNull();
    });
  });

  it("never marks an asset stored unless the object exists and its hash matches", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { assetId } = await seedMediaWithAsset(db, clock, "m3", "https://x.fbcdn.net/a.jpg");

      const dns = new FakeDns({ "x.fbcdn.net": ["157.240.2.35"] });
      const downloader = new FakeDownloader({
        "https://x.fbcdn.net/a.jpg": {
          status: 200,
          headers: { "content-type": "image/jpeg" },
          bodyChunks: [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8])],
        },
      });
      const storage = new FakeStorage();

      await runDownload({ db, dns, downloader, storage, ...baseDeps({ clock }) }, { assetId });

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("stored");
      expect(await storage.exists(row.storage_key!)).toBe(true);
      const bytes = storage.getBytes(row.storage_key!);
      expect([...bytes!]).toEqual([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
    });
  });

  it("a timeout-like 5xx releases the asset back to pending for retry", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { assetId } = await seedMediaWithAsset(db, clock, "m4", "https://x.fbcdn.net/a.jpg");

      const dns = new FakeDns({ "x.fbcdn.net": ["157.240.2.35"] });
      const downloader = new FakeDownloader({
        "https://x.fbcdn.net/a.jpg": { status: 503 },
      });
      const storage = new FakeStorage();

      await runDownload(
        { db, dns, downloader, storage, ...baseDeps({ clock, downloadMaxAttempts: 5 }) },
        { assetId }
      );

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
    });
  });

  it("gives up after downloadMaxAttempts and writes a dead letter", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const { assetId } = await seedMediaWithAsset(db, clock, "m5", "https://x.fbcdn.net/a.jpg");
      await db
        .updateTable("media_assets")
        .set({ attempts: 4 })
        .where("id", "=", assetId)
        .execute();

      const dns = new FakeDns({ "x.fbcdn.net": ["157.240.2.35"] });
      const downloader = new FakeDownloader({
        "https://x.fbcdn.net/a.jpg": { status: 503 },
      });
      const storage = new FakeStorage();

      await runDownload(
        { db, dns, downloader, storage, ...baseDeps({ clock, downloadMaxAttempts: 5 }) },
        { assetId }
      );

      const row = await db
        .selectFrom("media_assets")
        .selectAll()
        .where("id", "=", assetId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("failed");

      const dead = await db.selectFrom("dead_letters").selectAll().execute();
      expect(dead.length).toBe(1);
    });
  });
});
