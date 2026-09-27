import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiskStorage } from "../../src/adapters/storage/disk-storage.js";
import { blobStorageContract } from "../contract/blob-storage.contract.js";

const sharedDir = mkdtempSync(path.join(tmpdir(), "hashtag-tracker-storage-"));

afterAll(async () => {
  await rm(sharedDir, { recursive: true, force: true });
});

blobStorageContract(() => new DiskStorage(sharedDir));

describe("DiskStorage", () => {
  it("writes the file to disk under the configured directory", async () => {
    async function* data() {
      yield new Uint8Array([1, 2, 3]);
    }
    const storage = new DiskStorage(sharedDir);
    await storage.put("sha256/ab/direct-write.jpg", data(), "image/jpeg");
    const written = readFileSync(path.join(sharedDir, "sha256/ab/direct-write.jpg"));
    expect([...written]).toEqual([1, 2, 3]);
  });
});
