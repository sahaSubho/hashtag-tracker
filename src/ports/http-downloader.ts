export interface DownloadResult {
  status: number;
  /** Present only on 3xx responses. */
  location: string | null;
  body: AsyncIterable<Uint8Array>;
  contentType: string | null;
  /** Lower-cased response header names. Added in Phase 2 for the Meta usage-header throttle (spec §8). */
  headers: Record<string, string>;
}

export interface HttpDownloader {
  /** Performs one HTTP GET with no automatic redirect following. */
  get(url: string): Promise<DownloadResult>;
}
