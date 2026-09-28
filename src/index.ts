import http from "node:http";
import { loadConfig } from "./config/env.js";
import { loadEnvFile } from "./config/load-env-file.js";
import { createLogger } from "./http/logger.js";
import { makeDb, makeReadDb } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { SystemClock } from "./adapters/clock/system-clock.js";
import { InMemoryQueue } from "./adapters/queue/in-memory-queue.js";
import { DiskStorage } from "./adapters/storage/disk-storage.js";
import { EnvSecretProvider } from "./adapters/secrets/env-secret-provider.js";
import { NodeFetchDownloader } from "./adapters/downloader/node-fetch-downloader.js";
import { SystemDns } from "./adapters/dns/system-dns.js";
import { PromMetrics } from "./adapters/metrics/prom-metrics.js";
import { createMetricsServer } from "./http/metrics-server.js";
import { HttpMetaClient } from "./adapters/meta/http-meta-client.js";
import { NodeCronScheduler } from "./adapters/scheduler/node-cron-scheduler.js";
import { bootstrap } from "./services/bootstrap.js";
import { runRelayOnce } from "./services/relay.js";
import { runSweeperOnce } from "./services/sweeper.js";
import { runWatchdogOnce } from "./services/watchdog.js";
import { runRetentionOnce } from "./services/retention.js";
import { SyncWorker } from "./workers/sync-worker.js";
import { DownloadWorker } from "./workers/download-worker.js";
import { InMemoryRateLimitStore } from "./adapters/rate-limit/in-memory-rate-limit-store.js";
import { LogAlertSink } from "./adapters/alerts/log-alert-sink.js";
import { ResponseCache } from "./graphql/response-cache.js";
import { SqsQueue } from "./adapters/aws/sqs-queue.js";
import { S3Storage } from "./adapters/aws/s3-storage.js";
import { SecretsManagerProvider } from "./adapters/aws/secrets-manager-provider.js";
import { SnsAlertSink } from "./adapters/aws/sns-alert-sink.js";
import { EventBridgeScheduler } from "./adapters/aws/eventbridge-scheduler.js";
import type { Queue } from "./ports/queue.js";
import type { BlobStorage } from "./ports/blob-storage.js";
import type { SecretProvider } from "./ports/secret-provider.js";
import type { AlertSink } from "./ports/alert-sink.js";
import type { Scheduler } from "./ports/scheduler.js";

const META_FIELDS =
  "id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count,children{media_type,media_url}";

const RELAY_INTERVAL_MS = 1000;
const SWEEPER_INTERVAL_MS = 60000;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WORKER_POLL_INTERVAL_MS = 1000;
const STALE_LEASE_GRACE_MS = 0;
const STALE_PENDING_GRACE_MS = 5 * 60 * 1000;
const SYNC_OVERDUE_GRACE_MS = 15 * 60 * 1000;
const OUTBOX_STALL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig(process.env);
  const logger = createLogger();
  logger.info({ appRoles: config.appRoles, nodeEnv: config.nodeEnv }, "starting hashtag-tracker");

  const clock = new SystemClock();

  // Local vs AWS behind the exact same interfaces (spec brief, "Queue,
  // Cron, And Storage": "structured so local implementations can later be
  // replaced with AWS implementations"). config.secretsSource is reused as
  // the single switch for all of them, since a real deployment flips every
  // backend at once — the assignment's own submission always runs local.
  const usingAws = config.secretsSource === "aws";

  const secrets: SecretProvider = usingAws
    ? new SecretsManagerProvider({ client: { region: config.awsRegion }, clock })
    : new EnvSecretProvider();
  const metaAccessToken = await secrets.get("META_ACCESS_TOKEN");
  if (!metaAccessToken) {
    throw new Error("META_ACCESS_TOKEN is required");
  }
  const metaAppSecret = await secrets.get("META_APP_SECRET");

  const db = makeDb(config.databaseUrl);
  await runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);

  // A separate, small pool for GraphQL dashboard reads (spec §10, §15.1) so
  // a saturated dashboard workload can never starve ingestion for
  // connections. In production this should authenticate as tracker_graphql;
  // locally/in dev it falls back to the same app connection string, which
  // is fine for the assignment's scope (no separate credential to manage)
  // but does NOT enforce read-only at the database level in that case — the
  // GraphQL server (P3-03/04) is responsible for only ever running reads.
  const readDb = makeReadDb(config.databaseUrlReadonly ?? config.databaseUrl);

  // Shared across the sync-worker (which clears/charges them) and the api
  // role's GraphQL server (which reads/checks them), in case both roles
  // run in this same process (the default APP_ROLES includes both).
  const graphqlResponseCache = new ResponseCache();
  const graphqlRateLimitStore = new InMemoryRateLimitStore(clock);

  const metrics = new PromMetrics();
  const metricsServer = createMetricsServer(metrics);
  metricsServer.listen(config.metricsPort, () => {
    logger.info({ port: config.metricsPort }, "metrics listening");
  });
  const queue: Queue = usingAws
    ? new SqsQueue({
        client: { region: config.awsRegion },
        queueUrl: requireAwsConfig(config.awsSqsQueueUrl, "AWS_SQS_QUEUE_URL"),
      })
    : new InMemoryQueue(clock);
  const storage: BlobStorage = usingAws
    ? new S3Storage({
        client: { region: config.awsRegion },
        bucket: requireAwsConfig(config.awsS3Bucket, "AWS_S3_BUCKET"),
      })
    : new DiskStorage(config.storageDir);
  const dns = new SystemDns();
  const httpDownloader = new NodeFetchDownloader();
  const meta = new HttpMetaClient({
    http: httpDownloader,
    accessToken: metaAccessToken,
    appSecret: metaAppSecret,
    igUserId: config.metaIgUserId,
    apiVersion: config.metaApiVersion,
    fields: META_FIELDS,
    clock,
    metrics,
    refreshAccessToken: async () => {
      const refreshed = await secrets.get("META_ACCESS_TOKEN");
      if (!refreshed) {
        throw new Error("META_ACCESS_TOKEN is required but became unavailable during refresh");
      }
      return refreshed;
    },
  });

  const intervals: ReturnType<typeof setInterval>[] = [];
  const workers: { handleSigterm(): void }[] = [];
  let httpServer: http.Server | undefined;
  let scheduler: Scheduler | undefined;

  if (config.appRoles.includes("relay")) {
    await bootstrap({
      db,
      meta,
      clock,
      hashtag: config.hashtag,
      syncIntervalMs: cronIntervalHintMs(config.syncIntervalCron),
    });

    intervals.push(
      setInterval(() => {
        void runRelayOnce({ db, queue, clock, metrics, batchSize: 100 }).catch((err) =>
          logger.error({ err }, "relay tick failed")
        );
      }, RELAY_INTERVAL_MS)
    );
    intervals.push(
      setInterval(() => {
        void runSweeperOnce({
          db,
          queue,
          clock,
          metrics,
          staleLeaseGraceMs: STALE_LEASE_GRACE_MS,
          stalePendingGraceMs: STALE_PENDING_GRACE_MS,
        }).catch((err) => logger.error({ err }, "sweeper tick failed"));
      }, SWEEPER_INTERVAL_MS)
    );

    const alertSink: AlertSink = usingAws
      ? new SnsAlertSink({
          client: { region: config.awsRegion },
          topicArn: requireAwsConfig(config.awsSnsAlertTopicArn, "AWS_SNS_ALERT_TOPIC_ARN"),
        })
      : new LogAlertSink({
          logger,
          slackWebhookUrl: (await secrets.get("SLACK_WEBHOOK_URL")) || undefined,
        });
    intervals.push(
      setInterval(() => {
        void runWatchdogOnce({
          db,
          clock,
          alerts: alertSink,
          hashtag: config.hashtag,
          syncIntervalMs: cronIntervalHintMs(config.syncIntervalCron),
          syncOverdueGraceMs: SYNC_OVERDUE_GRACE_MS,
          outboxStallMs: OUTBOX_STALL_MS,
        }).catch((err) => logger.error({ err }, "watchdog tick failed"));
      }, WATCHDOG_INTERVAL_MS)
    );

    intervals.push(
      setInterval(() => {
        void runRetentionOnce({
          db,
          clock,
          storage,
          mediaRetentionDays: config.mediaRetentionDays,
        }).catch((err) => logger.error({ err }, "retention tick failed"));
      }, RETENTION_INTERVAL_MS)
    );
  }

  if (config.appRoles.includes("scheduler")) {
    // In a real AWS deployment the "scheduler" role should not be enabled
    // at all — EventBridge Scheduler (created by the Pulumi stack, not by
    // this process) replaces it entirely. EventBridgeScheduler exists so
    // this branch still constructs something rather than silently running
    // NodeCronScheduler's local cron against production, and its start()
    // logs a loud warning precisely because reaching it means the role
    // wiring is misconfigured for this deployment.
    scheduler = usingAws
      ? new EventBridgeScheduler({ logger })
      : new NodeCronScheduler({
          db,
          clock,
          hashtag: config.hashtag,
          cronExpression: config.syncIntervalCron,
        });
    scheduler.start();
  }

  if (config.appRoles.includes("sync-worker")) {
    const worker = new SyncWorker({
      queue,
      metrics,
      syncDeps: {
        db,
        meta,
        clock,
        syncMaxItems: config.syncMaxItems,
        syncSkewMinutes: config.syncSkewMinutes,
        onSyncFinished: () => graphqlResponseCache.clear(),
      },
    });
    workers.push(worker);
    intervals.push(
      setInterval(() => {
        void worker.runOnce().catch((err) => logger.error({ err }, "sync worker tick failed"));
      }, WORKER_POLL_INTERVAL_MS)
    );
  }

  if (config.appRoles.includes("download-worker")) {
    const worker = new DownloadWorker({
      queue,
      metrics,
      concurrency: config.downloadConcurrency,
      downloadDeps: {
        db,
        dns,
        downloader: httpDownloader,
        storage,
        clock,
        hostAllowlist: config.mediaHostAllowlist,
        maxBytes: config.maxAssetBytes,
        downloadLeaseSeconds: config.downloadLeaseSeconds,
        downloadMaxAttempts: config.downloadMaxAttempts,
      },
    });
    workers.push(worker);
    intervals.push(
      setInterval(() => {
        void worker.runOnce().catch((err) => logger.error({ err }, "download worker tick failed"));
      }, WORKER_POLL_INTERVAL_MS)
    );
  }

  if (config.appRoles.includes("api")) {
    const app = createApp({
      db,
      storage,
      cursorKeys: config.cursorSigningKeys,
      hashtag: config.hashtag,
      storageDir: config.storageDir,
      trustProxy: config.trustProxy,
      rateLimit: {
        store: new InMemoryRateLimitStore(clock),
        limit: config.restRatePerMin,
        windowMs: 60000,
        burst: config.restBurst,
      },
      metrics,
      clock,
      enableInternalRoutes: true,
      readDb,
      graphqlNodeEnv: config.nodeEnv,
      graphqlRateLimitStore: graphqlRateLimitStore,
      graphqlCostPerMin: config.graphqlCostPerMin,
      graphqlResponseCache,
    });
    httpServer = app.listen(config.port, () => {
      logger.info({ port: config.port }, "api listening");
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    for (const worker of workers) worker.handleSigterm();
    for (const interval of intervals) clearInterval(interval);
    await scheduler?.stop();

    await new Promise((resolve) => setTimeout(resolve, config.shutdownGraceMs));

    await new Promise<void>((resolve) => {
      if (httpServer) httpServer.close(() => resolve());
      else resolve();
    });
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));

    await db.destroy();
    await readDb.destroy();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/** Fails fast with a clear message when an AWS backend is selected but its resource identifier wasn't configured. */
function requireAwsConfig(value: string | undefined, envVar: string): string {
  if (!value) {
    throw new Error(`${envVar} is required when SECRETS_SOURCE=aws (usingAws backends)`);
  }
  return value;
}

/** A rough ms estimate of the configured cron interval, for the bootstrap catch-up check. */
function cronIntervalHintMs(cronExpression: string): number {
  const match = cronExpression.match(/^0 \*\/(\d+) \* \* \*$/);
  const hours = match ? Number(match[1]) : 3;
  return hours * 60 * 60 * 1000;
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
