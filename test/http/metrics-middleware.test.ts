import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeStorage, RecordingMetrics } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";

describe("HTTP request duration metric", () => {
  it("observes http_request_duration_seconds for each request", async () => {
    await withTestDb(async (db) => {
      await db.insertInto("hashtags").values({ name: "matcha", ig_hashtag_id: "17843" }).execute();
      const metrics = new RecordingMetrics();
      const app = createApp({
        db,
        storage: new FakeStorage(),
        cursorKeys: [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
        hashtag: "matcha",
        metrics,
      });

      await request(app).get("/hashtags");

      const obs = metrics.observations.find((o) => o.name === "http_request_duration_seconds");
      expect(obs).toBeDefined();
      expect(obs?.labels?.route).toBeDefined();
      expect(obs?.labels?.status).toBe("200");
    });
  });
});
