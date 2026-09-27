import express, { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import type { CursorSigningKey } from "../domain/cursor.js";
import type { Metrics } from "../ports/metrics.js";
import type { Clock } from "../ports/clock.js";
import { SystemClock } from "../adapters/clock/system-clock.js";
import { hashtagsRouter } from "./routes/hashtags.js";
import { filesRouter } from "./routes/files.js";
import { healthRouter } from "./routes/health.js";
import { internalStatusRouter } from "./routes/internal-status.js";
import { rateLimitMiddleware, type RateLimitConfig } from "./rate-limit-middleware.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export interface AppDeps {
  db: Kysely<DB>;
  storage: BlobStorage;
  cursorKeys: CursorSigningKey[];
  hashtag: string;
  storageDir?: string;
  /** Omitted disables rate limiting (e.g. in most tests). */
  rateLimit?: RateLimitConfig;
  /** Express `trust proxy` setting — number of proxy hops to trust. Default 0 (spec §13.3). */
  trustProxy?: number;
  /** Omitted disables the http_request_duration_seconds observation (spec §12.2). */
  metrics?: Metrics;
  /** Used by /readyz's staleness check. Defaults to the real system clock. */
  clock?: Clock;
  /** Omitted disables GET /internal/status entirely (404, not just unauthorized). */
  adminToken?: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set("trust proxy", deps.trustProxy ?? 0);

  app.use((req, res, next) => {
    req.id = randomUUID();
    res.set("X-Request-Id", req.id);
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  if (deps.metrics) {
    app.use(requestDurationMiddleware(deps.metrics));
  }

  app.use(healthRouter({ db: deps.db, clock: deps.clock ?? new SystemClock() }));

  if (deps.rateLimit) {
    app.use(rateLimitMiddleware(deps.rateLimit));
  }

  app.use(
    hashtagsRouter({
      db: deps.db,
      storage: deps.storage,
      cursorKeys: deps.cursorKeys,
      defaultHashtag: deps.hashtag,
    })
  );
  if (deps.storageDir) {
    app.use(filesRouter({ storageDir: deps.storageDir }));
  }
  if (deps.adminToken) {
    app.use(internalStatusRouter({ db: deps.db, storage: deps.storage, adminToken: deps.adminToken }));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "not found" } });
  });

  return app;
}

function requestDurationMiddleware(metrics: Metrics) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // req.route is only set once Express has matched a route; fall back
      // to the raw path for 404s and other unmatched requests.
      const route = req.route?.path ?? req.path;
      metrics.observe("http_request_duration_seconds", seconds, {
        route: String(route),
        status: String(res.statusCode),
      });
    });
    next();
  };
}
