import { describe, it, expect } from "vitest";
import { mapMetaItem } from "../../src/domain/mapper.js";

const img = {
  id: "1",
  media_type: "IMAGE",
  permalink: "p",
  timestamp: "2026-09-27T08:00:00+0000",
  media_url: "https://x.fbcdn.net/a.jpg",
  caption: "hi",
  like_count: 5,
  comments_count: 1,
};

describe("mapMetaItem", () => {
  it("maps a single image to one pending asset", () => {
    const r = mapMetaItem(img);
    expect("ok" in r && r.ok.assets).toEqual([
      {
        position: 0,
        kind: "image",
        sourceUrl: "https://x.fbcdn.net/a.jpg",
        sourceUrlExpiresAt: null,
        status: "pending",
      },
    ]);
  });

  it("maps core fields", () => {
    const r = mapMetaItem(img);
    expect("ok" in r).toBe(true);
    if ("ok" in r) {
      expect(r.ok.igMediaId).toBe("1");
      expect(r.ok.mediaType).toBe("IMAGE");
      expect(r.ok.permalink).toBe("p");
      expect(r.ok.igTimestamp.toISOString()).toBe("2026-09-27T08:00:00.000Z");
      expect(r.ok.likeCount).toBe(5);
      expect(r.ok.commentsCount).toBe(1);
      expect(r.ok.caption).toBe("hi");
    }
  });

  it("strips NUL from captions instead of rejecting", () => {
    const r = mapMetaItem({ ...img, caption: "a\u0000b" });
    expect("ok" in r && r.ok.caption).toBe("ab");
  });

  it("maps a carousel to one asset per child", () => {
    const r = mapMetaItem({
      ...img,
      media_type: "CAROUSEL_ALBUM",
      media_url: undefined,
      children: {
        data: [
          { media_type: "IMAGE", media_url: "https://x.fbcdn.net/1.jpg" },
          { media_type: "VIDEO", media_url: "https://x.fbcdn.net/2.mp4" },
        ],
      },
    });
    expect("ok" in r && r.ok.assets.length).toBe(2);
    if ("ok" in r) {
      expect(r.ok.assets[0]).toMatchObject({ position: 0, kind: "image" });
      expect(r.ok.assets[1]).toMatchObject({ position: 1, kind: "video" });
    }
  });

  it("stores a post with no url as a no_url asset", () => {
    const r = mapMetaItem({ ...img, media_url: undefined, children: undefined });
    expect("ok" in r && r.ok.assets[0]?.status).toBe("no_url");
  });

  it("rejects an unknown media_type", () => {
    const r = mapMetaItem({ ...img, media_type: "STORY" });
    expect("rejected" in r && r.rejected.reason).toMatch(/media_type/);
  });

  it("rejects a missing id", () => {
    const r = mapMetaItem({ ...img, id: undefined });
    expect("rejected" in r).toBe(true);
  });

  it("rejects a missing permalink", () => {
    const r = mapMetaItem({ ...img, permalink: undefined });
    expect("rejected" in r).toBe(true);
  });

  it("rejects a missing timestamp", () => {
    const r = mapMetaItem({ ...img, timestamp: undefined });
    expect("rejected" in r).toBe(true);
  });

  it("caps caption length at 10000 characters", () => {
    const r = mapMetaItem({ ...img, caption: "a".repeat(20000) });
    expect("ok" in r && r.ok.caption?.length).toBe(10000);
  });

  it("never includes an unsanitized url in a rejected excerpt", () => {
    const r = mapMetaItem({
      ...img,
      media_type: "STORY",
      media_url: "https://x.fbcdn.net/a.jpg?access_token=SECRET123",
    });
    expect("rejected" in r && r.rejected.excerpt).not.toContain("SECRET123");
  });

  it("accepts a null caption the same as a missing one, instead of rejecting or crashing", () => {
    const r = mapMetaItem({ ...img, caption: null });
    expect("ok" in r && r.ok.caption).toBeNull();
  });

  it("accepts null like_count and comments_count the same as missing", () => {
    const r = mapMetaItem({ ...img, like_count: null, comments_count: null });
    expect("ok" in r && r.ok.likeCount).toBeNull();
    expect("ok" in r && r.ok.commentsCount).toBeNull();
  });
});
