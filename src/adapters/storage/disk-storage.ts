import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BlobStorage } from "../../ports/blob-storage.js";

/**
 * Local-disk BlobStorage implementation (spec §4.1). Writes go to a temp
 * file in the same directory and are atomically renamed into place, so a
 * crash mid-write never leaves a partial file at the final path.
 */
export class DiskStorage implements BlobStorage {
  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    return path.join(this.rootDir, key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    _contentType: string
  ): Promise<void> {
    const finalPath = this.resolve(key);
    const dir = path.dirname(finalPath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = path.join(dir, `.tmp-${randomUUID()}`);
    const handle = await fs.open(tempPath, "w");
    try {
      for await (const chunk of body) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, finalPath);
  }

  async getReadUrl(key: string): Promise<string> {
    return `/files/${key}`;
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
