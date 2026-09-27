import { describe, it, expect } from "vitest";
import { FakeClock } from "../helpers/fakes.js";
import { InMemoryRateLimitStore } from "../../src/adapters/rate-limit/in-memory-rate-limit-store.js";

describe("InMemoryRateLimitStore", () => {
  it("allows up to the configured limit within a window", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemoryRateLimitStore(clock);
    const opts = { key: "ip:1.2.3.4", limit: 3, windowMs: 60000, burst: 0 };
    expect((await store.consume(opts)).allowed).toBe(true);
    expect((await store.consume(opts)).allowed).toBe(true);
    expect((await store.consume(opts)).allowed).toBe(true);
    expect((await store.consume(opts)).allowed).toBe(false);
  });

  it("refills after the window passes", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemoryRateLimitStore(clock);
    const opts = { key: "ip:1.2.3.4", limit: 1, windowMs: 60000, burst: 0 };
    expect((await store.consume(opts)).allowed).toBe(true);
    expect((await store.consume(opts)).allowed).toBe(false);
    clock.advance(60000);
    expect((await store.consume(opts)).allowed).toBe(true);
  });

  it("keeps separate buckets per key", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemoryRateLimitStore(clock);
    const a = { key: "ip:1.1.1.1", limit: 1, windowMs: 60000, burst: 0 };
    const b = { key: "ip:2.2.2.2", limit: 1, windowMs: 60000, burst: 0 };
    expect((await store.consume(a)).allowed).toBe(true);
    expect((await store.consume(b)).allowed).toBe(true);
    expect((await store.consume(a)).allowed).toBe(false);
    expect((await store.consume(b)).allowed).toBe(false);
  });

  it("allows an extra burst on top of the steady limit", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemoryRateLimitStore(clock);
    const opts = { key: "ip:1.2.3.4", limit: 2, windowMs: 60000, burst: 1 };
    expect((await store.consume(opts)).allowed).toBe(true);
    expect((await store.consume(opts)).allowed).toBe(true);
    expect((await store.consume(opts)).allowed).toBe(true); // burst
    expect((await store.consume(opts)).allowed).toBe(false);
  });

  it("reports retryAfterMs when denied", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemoryRateLimitStore(clock);
    const opts = { key: "ip:1.2.3.4", limit: 1, windowMs: 60000, burst: 0 };
    await store.consume(opts);
    const result = await store.consume(opts);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it("reports remaining count", async () => {
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemoryRateLimitStore(clock);
    const opts = { key: "ip:1.2.3.4", limit: 3, windowMs: 60000, burst: 0 };
    const r1 = await store.consume(opts);
    expect(r1.remaining).toBe(2);
  });
});
