import express, { type Express } from "express";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import type { CursorSigningKey } from "../domain/cursor.js";
import { hashtagsRouter } from "./routes/hashtags.js";
import { filesRouter } from "./routes/files.js";
import { healthRouter } from "./routes/health.js";

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
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use((req, res, next) => {
    req.id = randomUUID();
    res.set("X-Request-Id", req.id);
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  app.use(healthRouter());
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
