import type { HttpDownloader, DownloadResult } from "../../ports/http-downloader.js";

const FETCH_TIMEOUT_MS = 30000;

/**
 * Real HttpDownloader using Node's built-in fetch, with redirects disabled
 * (guardedDownload follows and re-validates them itself) and a timeout.
 */
export class NodeFetchDownloader implements HttpDownloader {
  async get(url: string): Promise<DownloadResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
      });

      return {
        status: response.status,
        location: response.headers.get("location"),
        contentType: response.headers.get("content-type"),
        body: streamBody(response),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function* streamBody(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
