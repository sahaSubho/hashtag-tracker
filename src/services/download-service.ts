import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { Clock } from "../ports/clock.js";
import type { Metrics } from "../ports/metrics.js";
import type { DnsResolver } from "../ports/dns-resolver.js";
import type { HttpDownloader } from "../ports/http-downloader.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import { guardedDownload, HttpStatusError } from "../adapters/downloader/fetch-downloader.js";
import { assetRepo } from "../db/repositories/asset-repo.js";
import { linkReposts } from "./repost-service.js";

export interface DownloadServiceDeps {
  db: Kysely<DB>;
  dns: DnsResolver;
  downloader: HttpDownloader;
  storage: BlobStorage;
  clock: Clock;
  metrics: Metrics;
  hostAllowlist: string[];
  maxBytes: number;
  downloadLeaseSeconds: number;
  downloadMaxAttempts: number;
}

export interface DownloadJobInput {
  assetId: number;
}

const ALLOWED_KINDS = new Set(["image", "video"]);

/**
 * Downloads and stores one asset (spec §6.4). Claims the asset with a
 * lease so a crash mid-download is recoverable by the sweeper, downloads
 * it through the SSRF-guarded downloader, hashes the bytes while
 * buffering, stores under a content-addressed key (dedupes identical
 * files automatically), and — for the primary (position 0) asset — runs
 * repost linking in the same transaction that marks it stored.
 */
export async function runDownload(deps: DownloadServiceDeps, job: DownloadJobInput): Promise<void> {
  const { db, clock, metrics } = deps;
  const leaseUntil = new Date(clock.now().getTime() + deps.downloadLeaseSeconds * 1000);

  const claimed = await db.transaction().execute((tx) => assetRepo.claim(tx, job.assetId, leaseUntil));
  if (!claimed) {
    // Already handled (claimed by another worker, or in a terminal state).
    return;
  }

  if (!claimed.source_url) {
    await db.transaction().execute((tx) => assetRepo.markStatus(tx, job.assetId, "failed", "no source_url"));
    return;
  }

  try {
    const result = await guardedDownload(
      {
        dns: deps.dns,
        inner: deps.downloader,
        hostAllowlist: deps.hostAllowlist,
        maxBytes: deps.maxBytes,
      },
      claimed.source_url
    );

    const chunks: Uint8Array[] = [];
    for await (const chunk of result.body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const detected = await fileTypeFromBuffer(buffer);
    const kind = detected?.mime.startsWith("video/") ? "video" : "image";
    if (!detected || !ALLOWED_KINDS.has(kind) || !detected.mime.match(/^(image|video)\//)) {
      await db
        .transaction()
        .execute((tx) => assetRepo.markStatus(tx, job.assetId, "failed", "disallowed file type"));
      metrics.inc("asset.download_failed", { reason: "disallowed_type" });
      return;
    }

    const hash = createHash("sha256").update(buffer).digest("hex");
    const storageKey = `sha256/${hash.slice(0, 2)}/${hash}.${detected.ext}`;

    if (!(await deps.storage.exists(storageKey))) {
      await deps.storage.put(
        storageKey,
        (async function* () {
          yield buffer;
        })(),
        detected.mime
      );
    }

    await db.transaction().execute(async (tx) => {
      await assetRepo.markStored(tx, job.assetId, {
        contentSha256: hash,
        storageKey,
        contentType: detected.mime,
        bytes: buffer.byteLength,
        storedAt: clock.now(),
      });

      if (claimed.position === 0) {
        await linkReposts(tx, claimed.media_id, hash, deps.metrics);
      }
    });

    metrics.inc("asset.stored");
  } catch (err) {
    await handleDownloadError(deps, job.assetId, claimed.attempts, err);
  }
}

async function handleDownloadError(
  deps: DownloadServiceDeps,
  assetId: number,
  attempts: number,
  err: unknown
): Promise<void> {
  const { db, metrics } = deps;

  if (err instanceof HttpStatusError && (err.status === 403 || err.status === 410)) {
    await db
      .transaction()
      .execute((tx) => assetRepo.markStatus(tx, assetId, "url_expired", err.message));
    metrics.inc("asset.download_failed", { reason: "url_expired" });
    return;
  }

  const isRetryable =
    err instanceof HttpStatusError ? err.status >= 500 || err.status === 429 : true;

  if (isRetryable && attempts < deps.downloadMaxAttempts) {
    await db.transaction().execute((tx) => assetRepo.markStatus(tx, assetId, "pending"));
    metrics.inc("asset.download_failed", { reason: "retryable" });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  await db.transaction().execute(async (tx) => {
    await assetRepo.markStatus(tx, assetId, "failed", message);
    await tx
      .insertInto("dead_letters")
      .values({
        job_kind: "DOWNLOAD_ASSET",
        payload: JSON.stringify({ assetId }),
        attempts,
        last_error: message,
      })
      .execute();
  });
  metrics.inc("asset.download_failed", { reason: "exhausted" });
}
