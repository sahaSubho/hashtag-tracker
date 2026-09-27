import { describe, it, expect } from "vitest";
import request from "supertest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeStorage } from "../helpers/fakes.js";
import { createApp } from "../../src/http/app.js";
import { heartbeatRepo } from "../../src/db/repositories/heartbeat-repo.js";

const cursorKeys = [{ kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }];

describe("GET /readyz", () => {
  it("returns 503 when the relay/sweeper have never checked in", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha", clock });
      const res = await request(app).get("/readyz");
      expect(res.status).toBe(503);
    });
  });

  it("returns 200 when the relay and sweeper checked in within the last 2 minutes", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      await heartbeatRepo.checkIn(db, "relay", clock.now());
      await heartbeatRepo.checkIn(db, "sweeper", clock.now());
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha", clock });
      const res = await request(app).get("/readyz");
      expect(res.status).toBe(200);
    });
  });

  it("returns 503 when a heartbeat is stale (older than 2 minutes)", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T12:00:00Z"));
      await heartbeatRepo.checkIn(db, "relay", clock.now());
      await heartbeatRepo.checkIn(db, "sweeper", clock.now());
      clock.advance(3 * 60000);
      const app = createApp({ db, storage: new FakeStorage(), cursorKeys, hashtag: "matcha", clock });
      const res = await request(app).get("/readyz");
      expect(res.status).toBe(503);
    });
  });
});
