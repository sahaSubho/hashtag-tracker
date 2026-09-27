import type { Kysely } from "kysely";
import type { DB, SyncStatus } from "../db/schema.js";
import type { MetaClient } from "../ports/meta-client.js";
import type { Clock } from "../ports/clock.js";
import type { Metrics } from "../ports/metrics.js";
import { mapMetaItem } from "../domain/mapper.js";
import { decideStop } from "../domain/watermark.js";
import { computeBackoffMs } from "../domain/backoff.js";
import { mediaRepo } from "../db/repositories/media-repo.js";
import { assetRepo } from "../db/repositories/asset-repo.js";
import { syncRunRepo } from "../db/repositories/sync-run-repo.js";
import { outboxRepo } from "../db/repositories/outbox-repo.js";
import { rejectedRepo } from "../db/repositories/rejected-repo.js";
import { refreshGroupTotalsForMedia } from "./repost-service.js";
import { MetaApiError } from "../adapters/meta/http-meta-client.js";

const DEFAULT_MAX_TEMPORARY_RETRIES = 5;
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * spec §7-A adaptive interval: after this many consecutive truncations for
 * one edge, a busy hashtag is clearly outrunning the normal cron cadence.
 * Rather than wait for the next scheduled cron tick, the follow-up after
 * the 2nd (and every subsequent) consecutive truncation is enqueued sooner.
 */
const ADAPTIVE_TRUNCATION_THRESHOLD = 2;
const ADAPTIVE_FOLLOWUP_DELAY_MS = 30 * 60 * 1000; // half the default 3h interval, per the plan

export interface SyncServiceDeps {
  db: Kysely<DB>;
  meta: MetaClient;
  clock: Clock;
  metrics: Metrics;
  syncMaxItems: number;
  syncSkewMinutes: number;
  maxTemporaryRetries?: number;
}

export interface SyncJobInput {
  hashtagId: number;
  edge: "top" | "recent";
  parentRunId?: string;
  cursor?: string | null;
  /** How many temporary-error retries have already happened for this logical sync chain. */
  temporaryAttempt?: number;
  /** How many consecutive TRUNCATED runs (including this one) precede this job (spec §7-A adaptive interval). */
  truncationChainLength?: number;
}

export interface SyncResult {
  status: SyncStatus;
  runId: string;
}

/**
 * Runs one sync of a hashtag's top or recent media (spec §6.2). Pages
 * through MetaClient, validating and upserting each item, until one of:
 * caught up with the watermark (recent only), the item cap is hit
 * (truncated + a follow-up job queued), or Meta has no more pages.
 *
 * Every media/asset/snapshot write for a page happens in one transaction
 * that also enqueues the DOWNLOAD_ASSET outbox rows for newly pending
 * assets — so a crash right after commit only risks losing the *publish*
 * step, which the relay/sweeper recover (failure mode D), never the write.
 */
export async function runSync(deps: SyncServiceDeps, job: SyncJobInput): Promise<SyncResult> {
  const { db, meta, clock, metrics, syncMaxItems, syncSkewMinutes } = deps;
  const skewMs = syncSkewMinutes * 60 * 1000;

  const watermark = job.parentRunId
    ? await parentWatermark(db, job.parentRunId)
    : await syncRunRepo.latestWatermark(db, job.hashtagId, job.edge);

  const run = await db
    .transaction()
    .execute((tx) =>
      syncRunRepo.create(tx, {
        hashtagId: job.hashtagId,
        edge: job.edge,
        watermarkBefore: watermark,
        parentRunId: job.parentRunId,
      })
    );

  const hashtag = await db
    .selectFrom("hashtags")
    .selectAll()
    .where("id", "=", job.hashtagId)
    .executeTakeFirstOrThrow();

  let cursor: string | null = job.cursor ?? null;
  let itemsSoFar = 0;
  let pages = 0;
  let newestSeen: Date | null = null;
  let oldestSeen: Date | null = null;
  let finalStatus: SyncStatus = "SUCCESS";
  let resumeCursor: string | null = null;

  for (;;) {
    let page;
    try {
      page = await meta.media(job.edge, hashtag.ig_hashtag_id, cursor);
    } catch (err) {
      return handleMetaError(deps, job, run.id, cursor, err);
    }
    pages++;

    const pageTimestamps: Date[] = [];
    let itemsNew = 0;
    let itemsRejected = 0;

    await db.transaction().execute(async (tx) => {
      for (const rawItem of page.items) {
        const mapped = mapMetaItem(rawItem);
        if ("rejected" in mapped) {
          await rejectedRepo.insert(tx, run.id, mapped.rejected);
          itemsRejected++;
          continue;
        }

        const { ok } = mapped;
        pageTimestamps.push(ok.igTimestamp);
        if (newestSeen === null || ok.igTimestamp > newestSeen) newestSeen = ok.igTimestamp;
        if (oldestSeen === null || ok.igTimestamp < oldestSeen) oldestSeen = ok.igTimestamp;

        const { mediaId, isNew, countsChanged } = await mediaRepo.upsert(tx, ok, clock);
        itemsNew += isNew ? 1 : 0;

        await tx
          .insertInto("media_hashtags")
          .values({
            media_id: mediaId,
            hashtag_id: job.hashtagId,
            edges: [job.edge],
            first_seen_at: clock.now(),
          })
          .onConflict((oc) =>
            oc.columns(["media_id", "hashtag_id"]).doUpdateSet((eb) => ({
              edges: eb.ref("excluded.edges"),
            }))
          )
          .execute();

        if (countsChanged) {
          await tx
            .insertInto("engagement_snapshots")
            .values({
              media_id: mediaId,
              captured_at: clock.now(),
              like_count: ok.likeCount,
              comments_count: ok.commentsCount,
              sync_run_id: run.id,
            })
            .onConflict((oc) => oc.columns(["media_id", "captured_at"]).doNothing())
            .execute();

          if (!isNew) {
            // A repeat sighting changed like/comment counts. If this post
            // already belongs to a repost group, its totals must be
            // recomputed here — link detection only runs once, at first
            // download, so later count changes would otherwise go stale.
            await refreshGroupTotalsForMedia(tx, mediaId);
          }
        }

        const assetResults = await assetRepo.upsertMany(tx, mediaId, ok.assets);
        for (const a of assetResults) {
          if (a.newlyPending) {
            await outboxRepo.enqueue(
              tx,
              "DOWNLOAD_ASSET",
              { assetId: a.assetId },
              clock.now()
            );
          }
        }
      }

      itemsSoFar += page.items.length - itemsRejected;
      await syncRunRepo.updateCounters(tx, run.id, {
        pages: 1,
        itemsFetched: page.items.length - itemsRejected,
        itemsNew,
        itemsRejected,
      });
    });

    metrics.inc("sync.page_fetched", { edge: job.edge });

    const decision = decideStop({
      edge: job.edge,
      pageTimestamps,
      watermark,
      skewMs,
      itemsSoFar,
      maxItems: syncMaxItems,
      hasNextCursor: page.nextCursor !== null,
    });

    if (decision === "cap_reached") {
      finalStatus = "TRUNCATED";
      resumeCursor = page.nextCursor ?? cursor;
      break;
    }
    if (decision === "caught_up" || decision === "exhausted") {
      finalStatus = "SUCCESS";
      break;
    }

    cursor = page.nextCursor;
  }

  await db.transaction().execute(async (tx) => {
    await syncRunRepo.finish(tx, run.id, {
      status: finalStatus,
      newestSeenTs: newestSeen,
      oldestSeenTs: oldestSeen,
      resumeCursor,
      gapStatus: finalStatus === "TRUNCATED" ? "open" : "none",
    });

    if (finalStatus === "TRUNCATED") {
      const chainLength = (job.truncationChainLength ?? 0) + 1;
      const delayMs =
        chainLength >= ADAPTIVE_TRUNCATION_THRESHOLD ? ADAPTIVE_FOLLOWUP_DELAY_MS : 0;

      await outboxRepo.enqueue(
        tx,
        "SYNC_HASHTAG_MEDIA",
        {
          hashtagId: job.hashtagId,
          edge: job.edge,
          parentRunId: run.id,
          cursor: resumeCursor,
          truncationChainLength: chainLength,
        },
        new Date(clock.now().getTime() + delayMs)
      );
      metrics.inc("sync.truncated", { edge: job.edge });
    } else if (job.parentRunId) {
      await syncRunRepo.closeParentGap(tx, job.parentRunId);
    }
  });

  metrics.inc("sync.completed", { edge: job.edge, status: finalStatus });

  return { status: finalStatus, runId: run.id };
}

async function parentWatermark(db: Kysely<DB>, parentRunId: string): Promise<Date | null> {
  const parent = await syncRunRepo.findById(db, parentRunId);
  return parent?.watermark_before ?? null;
}

/**
 * Handles an error thrown by MetaClient.media() (spec §8 error taxonomy):
 *
 * - fatal (e.g. token invalid, code 190): fail the run immediately, no
 *   retry — the account needs manual intervention (a new token).
 * - rate_limit: save the resume cursor and re-enqueue through the outbox
 *   with a delay, so the retry resumes from where it left off rather than
 *   re-reading pages already fetched. The run stays RUNNING; a later
 *   attempt (a fresh runSync call with the same runId as parent) finishes
 *   it.
 * - temporary (5xx, network, or unrecognized codes): same resume-cursor
 *   re-enqueue, but with exponential backoff and a capped attempt count —
 *   once exhausted, the run is marked FAILED.
 *
 * Delays are always expressed as `outbox.available_at`, which has no
 * 15-minute ceiling the way SQS does, so a long backoff or a Meta-given
 * reset time is handled the same way as any other delayed job.
 */
async function handleMetaError(
  deps: SyncServiceDeps,
  job: SyncJobInput,
  runId: string,
  cursor: string | null,
  err: unknown
): Promise<SyncResult> {
  const { db, clock, metrics } = deps;

  if (!(err instanceof MetaApiError)) {
    // An unexpected (non-Meta-API) error — treat as temporary/unknown.
    return handleMetaError(deps, job, runId, cursor, new MetaApiError(-1, String(err)));
  }

  if (err.category === "fatal") {
    await db.transaction().execute((tx) =>
      syncRunRepo.finish(tx, runId, {
        status: "FAILED",
        errorCode: String(err.code),
        errorMessage: err.message,
      })
    );
    metrics.inc("meta.token_invalid");
    return { status: "FAILED", runId };
  }

  if (err.category === "rate_limit") {
    metrics.inc("meta.rate_limited");
    await requeue(db, job, runId, cursor, clock, BACKOFF_BASE_MS, String(err.code), err.message);
    return { status: "RUNNING", runId };
  }

  // temporary
  const attempt = (job.temporaryAttempt ?? 0) + 1;
  const maxRetries = deps.maxTemporaryRetries ?? DEFAULT_MAX_TEMPORARY_RETRIES;

  if (attempt > maxRetries) {
    await db.transaction().execute((tx) =>
      syncRunRepo.finish(tx, runId, {
        status: "FAILED",
        errorCode: String(err.code),
        errorMessage: err.message,
      })
    );
    return { status: "FAILED", runId };
  }

  const delayMs = computeBackoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS);
  await requeue(db, job, runId, cursor, clock, delayMs, String(err.code), err.message, attempt);
  return { status: "RUNNING", runId };
}

async function requeue(
  db: Kysely<DB>,
  job: SyncJobInput,
  runId: string,
  cursor: string | null,
  clock: Clock,
  delayMs: number,
  errorCode: string,
  errorMessage: string,
  temporaryAttempt?: number
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await syncRunRepo.recordPause(tx, runId, { resumeCursor: cursor, errorCode, errorMessage });
    await outboxRepo.enqueue(
      tx,
      "SYNC_HASHTAG_MEDIA",
      {
        hashtagId: job.hashtagId,
        edge: job.edge,
        parentRunId: job.parentRunId ?? runId,
        cursor,
        temporaryAttempt,
      },
      new Date(clock.now().getTime() + delayMs)
    );
  });
}
