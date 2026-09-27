import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, RecordingMetrics } from "../helpers/fakes.js";
import { mediaRepo } from "../../src/db/repositories/media-repo.js";
import { linkReposts } from "../../src/services/repost-service.js";
import { captionNormHash } from "../../src/domain/caption.js";
import type { MappedMedia } from "../../src/domain/types.js";

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

const LONG_CAPTION =
  "the best matcha latte recipe you will ever make at home, guaranteed to impress";

describe("linkReposts metrics", () => {
  it("increments repost.linked_total{reason} when a repost is linked", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const metrics = new RecordingMetrics();
      const hash = captionNormHash(LONG_CAPTION);

      await db
        .transaction()
        .execute((tx) =>
          mediaRepo.upsert(tx, media({ igMediaId: "orig", caption: LONG_CAPTION, captionNormHash: hash }), clock)
        );
      const { mediaId } = await db
        .transaction()
        .execute((tx) =>
          mediaRepo.upsert(
            tx,
            media({ igMediaId: "repost", igTimestamp: new Date("2026-09-27T10:00:00Z"), caption: LONG_CAPTION, captionNormHash: hash }),
            clock
          )
        );

      await db.transaction().execute((tx) => linkReposts(tx, mediaId, null, metrics));

      expect(metrics.countOf("repost.linked_total")).toBe(1);
      const incCall = metrics.incs.find((i) => i.name === "repost.linked_total");
      expect(incCall?.labels).toMatchObject({ reason: "caption" });
    });
  });

  it("does not increment when no match is found", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const metrics = new RecordingMetrics();
      const { mediaId } = await db
        .transaction()
        .execute((tx) => mediaRepo.upsert(tx, media({ igMediaId: "alone" }), clock));

      await db.transaction().execute((tx) => linkReposts(tx, mediaId, null, metrics));

      expect(metrics.countOf("repost.linked_total")).toBe(0);
    });
  });
});
