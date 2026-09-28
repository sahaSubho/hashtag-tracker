import { Router, type RequestHandler } from "express";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";
import type { BlobStorage } from "../../ports/blob-storage.js";
import type { Clock } from "../../ports/clock.js";
import type { CursorSigningKey } from "../../domain/cursor.js";
import type { RateLimitStore } from "../../ports/rate-limit-store.js";
import { authenticateApiKey } from "../api-key-auth.js";
import { createGraphqlServer } from "../../graphql/server.js";
import type { ResponseCache } from "../../graphql/response-cache.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireDashboardApiKey once auth succeeds; read by the yoga context factory for caching/rate-limiting keys. */
    apiKeyId?: string;
  }
}

export interface GraphqlRouteDeps {
  readDb: Kysely<DB>;
  db: Kysely<DB>;
  storage: BlobStorage;
  cursorKeys: CursorSigningKey[];
  clock: Clock;
  nodeEnv?: string;
  rateLimitStore?: RateLimitStore;
  costPerMin?: number;
  /** Owned by the caller so it can be cleared on sync completion (spec §10). Created internally if omitted. */
  responseCache?: ResponseCache;
}

const DASHBOARD_SCOPE = "dashboard:read";
const GRAPHQL_ENDPOINT = "/graphql";

function requireDashboardApiKey(db: Kysely<DB>, clock: Clock): RequestHandler {
  return async (req, res, next) => {
    const auth = req.get("authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

    if (!key) {
      res.status(401).json({ error: { code: "unauthorized", message: "missing API key" } });
      return;
    }

    // Auth is checked against the ingestion db (deps.db), not readDb — API
    // key rows are written by the CLI through the app role, and this keeps
    // auth checks off the tightly-scoped, statement_timeout-limited
    // tracker_graphql pool the actual dashboard queries run through.
    const result = await authenticateApiKey(db, clock, key, DASHBOARD_SCOPE);
    if (!result.ok) {
      res.status(result.reason === "missing_scope" ? 403 : 401).json({
        error: { code: "unauthorized", message: "invalid or insufficiently-scoped API key" },
      });
      return;
    }

    req.apiKeyId = result.keyId;
    next();
  };
}

/**
 * Mounts the GraphQL dashboard API at /graphql (spec §10, §11), gated by a
 * dashboard:read-scoped API key. The actual resolvers run their reads
 * against `readDb` (the separate P3-02 pool), never `db`.
 */
export function graphqlRouter(deps: GraphqlRouteDeps): Router {
  const router = Router();
  router.use(GRAPHQL_ENDPOINT, requireDashboardApiKey(deps.db, deps.clock));

  const yoga = createGraphqlServer({
    readDb: deps.readDb,
    storage: deps.storage,
    cursorKeys: deps.cursorKeys,
    graphqlEndpoint: GRAPHQL_ENDPOINT,
    nodeEnv: deps.nodeEnv,
    rateLimitStore: deps.rateLimitStore,
    costPerMin: deps.costPerMin,
    responseCache: deps.responseCache,
  });

  // Passing `req` as yoga's extra server context (its documented Express
  // integration point) is what makes `req.apiKeyId`, set by the auth
  // middleware above, reachable from the GraphQL context factory in
  // server.ts — yoga's own `context.request` is a reconstructed WHATWG
  // Request, not this Express req, so it never carries values Express
  // middleware attached upstream.
  router.use(GRAPHQL_ENDPOINT, (req, res) => yoga.handle(req, res, { req }));
  return router;
}
