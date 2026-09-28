import { describe, it, expect, vi } from "vitest";
import { EventBridgeScheduler } from "../../src/adapters/aws/eventbridge-scheduler.js";

describe("EventBridgeScheduler", () => {
  it("start() logs a warning instead of throwing or scheduling anything", () => {
    const warn = vi.fn();
    const scheduler = new EventBridgeScheduler({ logger: { warn } });
    expect(() => scheduler.start()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/no-op placeholder/i);
  });

  it("stop() resolves without doing anything", async () => {
    const scheduler = new EventBridgeScheduler({ logger: { warn: vi.fn() } });
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});
