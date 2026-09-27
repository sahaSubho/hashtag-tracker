import { describe, it, expect } from "vitest";
import type { MetaClient } from "../../src/ports/meta-client.js";

/**
 * Shared contract every MetaClient implementation must satisfy. The
 * ScriptedMetaClient test fake and the real HttpMetaClient (exercised only
 * against recorded fixtures, never live, in the default test run) both run
 * this suite.
 */
export function metaClientContract(makeClient: () => MetaClient): void {
  describe("MetaClient contract", () => {
    it("media() returns a page shape with items, nextCursor, and usagePct", async () => {
      const client = makeClient();
      const page = await client.media("recent", "17843", null);
      expect(Array.isArray(page.items)).toBe(true);
      expect(page.nextCursor === null || typeof page.nextCursor === "string").toBe(true);
      expect(page.usagePct === null || typeof page.usagePct === "number").toBe(true);
    });

    it("debugToken() returns a health shape", async () => {
      const client = makeClient();
      const health = await client.debugToken();
      expect(typeof health.valid).toBe("boolean");
      expect(Array.isArray(health.scopes)).toBe(true);
      expect(health.expiresAt === null || health.expiresAt instanceof Date).toBe(true);
    });
  });
}
