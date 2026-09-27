export interface DownloadResult {
  body: AsyncIterable<Uint8Array>;
  contentType: string | null;
}

export interface HttpDownloader {
  get(url: string): Promise<DownloadResult>;
}
