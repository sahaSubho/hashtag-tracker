import { describe, it, expect } from "vitest";
import { FakeClock, FakeQueue } from "../helpers/fakes.js";

describe("fakes", () => {
  it("FakeClock advances and reports the current time", () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(5000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:05.000Z");
  });

  it("FakeQueue hides delayed jobs until the clock advances", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const q = new FakeQueue(clock);
    await q.enqueue("X", { a: 1 }, { delayMs: 1000 });
    expect(await q.receive(["X"], 10)).toHaveLength(0);
    clock.advance(1000);
    expect(await q.receive(["X"], 10)).toHaveLength(1);
  });

  it("FakeQueue delivers immediately without a delay", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const q = new FakeQueue(clock);
    await q.enqueue("X", { a: 1 });
    expect(await q.receive(["X"], 10)).toHaveLength(1);
  });

  it("FakeQueue does not redeliver an acked job", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const q = new FakeQueue(clock);
    await q.enqueue("X", { a: 1 });
    const [job] = await q.receive(["X"], 10);
    await q.ack(job!);
    expect(await q.receive(["X"], 10)).toHaveLength(0);
  });

  it("FakeQueue redelivers a released job after its delay", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const q = new FakeQueue(clock);
    await q.enqueue("X", { a: 1 });
    const [job] = await q.receive(["X"], 10);
    await q.release(job!, { delayMs: 500 });
    expect(await q.receive(["X"], 10)).toHaveLength(0);
    clock.advance(500);
    expect(await q.receive(["X"], 10)).toHaveLength(1);
  });
});
