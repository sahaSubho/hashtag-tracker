export interface BlobStorage {
  exists(key: string): Promise<boolean>;
  put(key: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<void>;
  getReadUrl(key: string): Promise<string>;
}
