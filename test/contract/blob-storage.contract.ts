import { describe, it, expect } from "vitest";
import type { BlobStorage } from "../../src/ports/blob-storage.js";

async function* bytes(data: number[]): AsyncIterable<Uint8Array> {
  yield new Uint8Array(data);
}

/**
 * Shared contract every BlobStorage implementation must pass. Run against
 * both FakeStorage (unit tests) and DiskStorage (integration test) so we
 * know the local adapter and its test double behave identically.
 */
export function blobStorageContract(makeStorage: () => BlobStorage): void {
  describe("BlobStorage contract", () => {
    it("put then exists is true", async () => {
      const storage = makeStorage();
      await storage.put("k1", bytes([1, 2, 3]), "image/jpeg");
      expect(await storage.exists("k1")).toBe(true);
    });

    it("exists is false for an unknown key", async () => {
      const storage = makeStorage();
      expect(await storage.exists("nope")).toBe(false);
    });

    it("getReadUrl returns a path containing the key", async () => {
      const storage = makeStorage();
      await storage.put("sha256/ab/abc123.jpg", bytes([1]), "image/jpeg");
      const url = await storage.getReadUrl("sha256/ab/abc123.jpg");
      expect(url).toContain("sha256/ab/abc123.jpg");
    });

    it("put is idempotent for the same key", async () => {
      const storage = makeStorage();
      await storage.put("k2", bytes([1, 2]), "image/jpeg");
      await storage.put("k2", bytes([1, 2]), "image/jpeg");
      expect(await storage.exists("k2")).toBe(true);
    });

    it("delete removes an existing key", async () => {
      const storage = makeStorage();
      await storage.put("k3", bytes([1]), "image/jpeg");
      await storage.delete("k3");
      expect(await storage.exists("k3")).toBe(false);
    });

    it("delete on an unknown key is a no-op, not an error", async () => {
      const storage = makeStorage();
      await expect(storage.delete("never-existed")).resolves.not.toThrow();
    });
  });
}
