import { describe, it, expect } from "vitest";
import { withTestDb } from "../helpers/pg.js";
import { FakeClock, FakeQueue, RecordingMetrics } from "../helpers/fakes.js";
import { runRelayOnce } from "../../src/services/relay.js";
import { runSweeperOnce } from "../../src/services/sweeper.js";
import { heartbeatRepo } from "../../src/db/repositories/heartbeat-repo.js";

describe("relay and sweeper check in a heartbeat on each run (spec §12.3)", () => {
  it("runRelayOnce records a heartbeat for 'relay'", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const queue = new FakeQueue(clock);
      await runRelayOnce({ db, queue, clock, metrics: new RecordingMetrics(), batchSize: 100 });

      const lastSeen = await heartbeatRepo.lastSeen(db, "relay");
      expect(lastSeen?.toISOString()).toBe(clock.now().toISOString());
    });
  });

  it("runSweeperOnce records a heartbeat for 'sweeper'", async () => {
    await withTestDb(async (db) => {
      const clock = new FakeClock(new Date("2026-09-27T09:00:00Z"));
      const queue = new FakeQueue(clock);
      await runSweeperOnce({
        db,
        queue,
        clock,
        metrics: new RecordingMetrics(),
        staleLeaseGraceMs: 0,
        stalePendingGraceMs: 300000,
      });

      const lastSeen = await heartbeatRepo.lastSeen(db, "sweeper");
      expect(lastSeen?.toISOString()).toBe(clock.now().toISOString());
    });
  });
});
