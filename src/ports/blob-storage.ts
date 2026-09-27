export interface BlobStorage {
  exists(key: string): Promise<boolean>;
  put(key: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<void>;
  getReadUrl(key: string): Promise<string>;
  /** Added in Phase 2 for the retention job (spec §6.8). A no-op if the key doesn't exist. */
  delete(key: string): Promise<void>;
}
