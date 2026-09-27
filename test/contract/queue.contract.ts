import { describe, it, expect } from "vitest";
import type { Queue } from "../../src/ports/queue.js";
import type { Clock } from "../../src/ports/clock.js";

export function queueContract(makeQueue: (clock: Clock) => Queue, makeClock: (start: Date) => Clock & { advance(ms: number): void }): void {
  describe("Queue contract", () => {
    it("delivers a job with no delay immediately", async () => {
      const clock = makeClock(new Date("2026-01-01T00:00:00Z"));
      const q = makeQueue(clock);
      await q.enqueue("X", { a: 1 });
      expect(await q.receive(["X"], 10)).toHaveLength(1);
    });

    it("hides a delayed job until the clock advances", async () => {
      const clock = makeClock(new Date("2026-01-01T00:00:00Z"));
      const q = makeQueue(clock);
      await q.enqueue("X", { a: 1 }, { delayMs: 1000 });
      expect(await q.receive(["X"], 10)).toHaveLength(0);
      clock.advance(1000);
      expect(await q.receive(["X"], 10)).toHaveLength(1);
    });

    it("does not redeliver an acked job", async () => {
      const clock = makeClock(new Date("2026-01-01T00:00:00Z"));
      const q = makeQueue(clock);
      await q.enqueue("X", { a: 1 });
      const [job] = await q.receive(["X"], 10);
      await q.ack(job!);
      expect(await q.receive(["X"], 10)).toHaveLength(0);
    });

    it("redelivers a released job after its delay", async () => {
      const clock = makeClock(new Date("2026-01-01T00:00:00Z"));
      const q = makeQueue(clock);
      await q.enqueue("X", { a: 1 });
      const [job] = await q.receive(["X"], 10);
      await q.release(job!, { delayMs: 500 });
      expect(await q.receive(["X"], 10)).toHaveLength(0);
      clock.advance(500);
      expect(await q.receive(["X"], 10)).toHaveLength(1);
    });

    it("only returns jobs of the requested kinds", async () => {
      const clock = makeClock(new Date("2026-01-01T00:00:00Z"));
      const q = makeQueue(clock);
      await q.enqueue("X", { a: 1 });
      await q.enqueue("Y", { a: 2 });
      const jobs = await q.receive(["X"], 10);
      expect(jobs.map((j) => j.kind)).toEqual(["X"]);
    });
  });
}
