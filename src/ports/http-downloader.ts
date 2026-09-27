export interface DownloadResult {
  status: number;
  /** Present only on 3xx responses. */
  location: string | null;
  body: AsyncIterable<Uint8Array>;
  contentType: string | null;
}

export interface HttpDownloader {
  /** Performs one HTTP GET with no automatic redirect following. */
  get(url: string): Promise<DownloadResult>;
}
