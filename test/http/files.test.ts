import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withTestDb } from "../helpers/pg.js";
import { FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";

const storageDir = mkdtempSync(path.join(tmpdir(), "hashtag-tracker-files-"));
writeFileSync(path.join(storageDir, "hello.jpg"), Buffer.from([1, 2, 3]));

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe("GET /files/*splat", () => {
  it("serves a nested file with nosniff and attachment headers", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys: [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
        hashtag: "matcha",
        storageDir,
      });

      const res = await request(app).get("/files/hello.jpg");
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toBe("attachment");
      expect([...res.body]).toEqual([1, 2, 3]);
    });
  });

  it("serves a file nested under a content-hash subdirectory", async () => {
    await withTestDb(async (db) => {
      const { mkdirSync, writeFileSync: write } = await import("node:fs");
      mkdirSync(path.join(storageDir, "sha256", "ab"), { recursive: true });
      write(path.join(storageDir, "sha256", "ab", "abc123.jpg"), Buffer.from([9, 9]));

      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys: [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
        hashtag: "matcha",
        storageDir,
      });

      const res = await request(app).get("/files/sha256/ab/abc123.jpg");
      expect(res.status).toBe(200);
      expect([...res.body]).toEqual([9, 9]);
    });
  });

  it("returns 400 for a path-traversal attempt", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys: [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
        hashtag: "matcha",
        storageDir,
      });

      const res = await request(app).get("/files/../../etc/passwd");
      expect([400, 404]).toContain(res.status);
    });
  });

  it("returns 404 for a missing file", async () => {
    await withTestDb(async (db) => {
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys: [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
        hashtag: "matcha",
        storageDir,
      });

      const res = await request(app).get("/files/nope.jpg");
      expect(res.status).toBe(404);
    });
  });
});
