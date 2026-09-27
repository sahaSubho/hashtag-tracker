import { z } from "zod";

const csv = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

const cursorKeys = (s: string): { kid: string; key: string }[] =>
  csv(s).map((pair) => {
    const idx = pair.indexOf(":");
    if (idx < 0) {
      throw new Error(`CURSOR_SIGNING_KEYS entry "${pair}" must be in kid:key form`);
    }
    return { kid: pair.slice(0, idx), key: pair.slice(idx + 1) };
  });

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ROLES: z
    .string()
    .default("api,sync-worker,download-worker,relay,scheduler")
    .transform(csv),
  PORT: z.coerce.number().int().default(3000),
  METRICS_PORT: z.coerce.number().int().default(9100),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_READONLY: z.string().optional(),
  DATABASE_URL_MIGRATOR: z.string().optional(),

  SECRETS_SOURCE: z.enum(["env", "aws"]).default("env"),

  HASHTAG: z.string().default("matcha"),
  META_API_VERSION: z.string().default("v24.0"),
  META_IG_USER_ID: z.string().min(1, "META_IG_USER_ID is required"),

  SYNC_INTERVAL_CRON: z.string().default("0 */3 * * *"),
  SYNC_MAX_ITEMS: z.coerce.number().int().default(500),
  SYNC_SKEW_MINUTES: z.coerce.number().int().default(10),

  DOWNLOAD_CONCURRENCY: z.coerce.number().int().default(5),
  DOWNLOAD_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  DOWNLOAD_LEASE_SECONDS: z.coerce.number().int().default(120),
  MAX_ASSET_BYTES: z.coerce.number().int().default(104857600),
  MEDIA_HOST_ALLOWLIST: z
    .string()
    .default("*.cdninstagram.com,*.fbcdn.net")
    .transform(csv),

  STORAGE_DIR: z.string().default("./storage"),

  CURSOR_SIGNING_KEYS: z.string().default("").transform(cursorKeys),

  TRUST_PROXY: z.coerce.number().int().default(0),
  REST_RATE_PER_MIN: z.coerce.number().int().default(60),
  REST_BURST: z.coerce.number().int().default(20),
  GRAPHQL_COST_PER_MIN: z.coerce.number().int().default(10000),

  RAW_RETENTION_DAYS: z.coerce.number().int().default(30),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().default(180),

  SHUTDOWN_GRACE_MS: z.coerce.number().int().default(25000),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  appRoles: string[];
  port: number;
  metricsPort: number;
  databaseUrl: string;
  databaseUrlReadonly?: string;
  databaseUrlMigrator?: string;
  secretsSource: "env" | "aws";
  hashtag: string;
  metaApiVersion: string;
  metaIgUserId: string;
  syncIntervalCron: string;
  syncMaxItems: number;
  syncSkewMinutes: number;
  downloadConcurrency: number;
  downloadMaxAttempts: number;
  downloadLeaseSeconds: number;
  maxAssetBytes: number;
  mediaHostAllowlist: string[];
  storageDir: string;
  cursorSigningKeys: { kid: string; key: string }[];
  trustProxy: number;
  restRatePerMin: number;
  restBurst: number;
  graphqlCostPerMin: number;
  rawRetentionDays: number;
  mediaRetentionDays: number;
  shutdownGraceMs: number;
};

export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  const parsed = rawSchema.parse(source);

  if (parsed.NODE_ENV === "production" && parsed.SECRETS_SOURCE === "env") {
    throw new Error(
      "SECRETS_SOURCE=env is not allowed in production — secrets must come from a SecretProvider (e.g. aws), never from process env"
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    appRoles: parsed.APP_ROLES,
    port: parsed.PORT,
    metricsPort: parsed.METRICS_PORT,
    databaseUrl: parsed.DATABASE_URL,
    databaseUrlReadonly: parsed.DATABASE_URL_READONLY,
    databaseUrlMigrator: parsed.DATABASE_URL_MIGRATOR,
    secretsSource: parsed.SECRETS_SOURCE,
    hashtag: parsed.HASHTAG,
    metaApiVersion: parsed.META_API_VERSION,
    metaIgUserId: parsed.META_IG_USER_ID,
    syncIntervalCron: parsed.SYNC_INTERVAL_CRON,
    syncMaxItems: parsed.SYNC_MAX_ITEMS,
    syncSkewMinutes: parsed.SYNC_SKEW_MINUTES,
    downloadConcurrency: parsed.DOWNLOAD_CONCURRENCY,
    downloadMaxAttempts: parsed.DOWNLOAD_MAX_ATTEMPTS,
    downloadLeaseSeconds: parsed.DOWNLOAD_LEASE_SECONDS,
    maxAssetBytes: parsed.MAX_ASSET_BYTES,
    mediaHostAllowlist: parsed.MEDIA_HOST_ALLOWLIST,
    storageDir: parsed.STORAGE_DIR,
    cursorSigningKeys: parsed.CURSOR_SIGNING_KEYS,
    trustProxy: parsed.TRUST_PROXY,
    restRatePerMin: parsed.REST_RATE_PER_MIN,
    restBurst: parsed.REST_BURST,
    graphqlCostPerMin: parsed.GRAPHQL_COST_PER_MIN,
    rawRetentionDays: parsed.RAW_RETENTION_DAYS,
    mediaRetentionDays: parsed.MEDIA_RETENTION_DAYS,
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
  };
}
