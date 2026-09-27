import express, { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import type { CursorSigningKey } from "../domain/cursor.js";
import { hashtagsRouter } from "./routes/hashtags.js";
import { filesRouter } from "./routes/files.js";
import { healthRouter } from "./routes/health.js";
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

  app.use(healthRouter());

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

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "not found" } });
  });

  return app;
}
