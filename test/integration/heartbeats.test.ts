import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock } from "../helpers/fakes.js";
import { heartbeatRepo } from "../../src/db/repositories/heartbeat-repo.js";

describe("heartbeatRepo", () => {
  it("records and reads back the last check-in time for a component", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await heartbeatRepo.checkIn(db, "relay", clock.now());
      const lastSeen = await heartbeatRepo.lastSeen(db, "relay");
      expect(lastSeen?.toISOString()).toBe("2026-09-27T09:00:00.000Z");
    });
  });

  it("returns null for a component that has never checked in", async () => {
    await withTestDb(async (db) => {
      const lastSeen = await heartbeatRepo.lastSeen(db, "sweeper");
      expect(lastSeen).toBeNull();
    });
  });

  it("updates on a repeat check-in rather than duplicating", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      await heartbeatRepo.checkIn(db, "relay", clock.now());
      clock.advance(60000);
      await heartbeatRepo.checkIn(db, "relay", clock.now());
      const lastSeen = await heartbeatRepo.lastSeen(db, "relay");
      expect(lastSeen?.toISOString()).toBe("2026-09-27T09:01:00.000Z");
    });
  });
});
