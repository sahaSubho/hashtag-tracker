import { Router, type RequestHandler } from "express";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema.js";
import type { BlobStorage } from "../../ports/blob-storage.js";
import type { Clock } from "../../ports/clock.js";
import type { CursorSigningKey } from "../../domain/cursor.js";
import { authenticateApiKey } from "../api-key-auth.js";
import { createGraphqlServer } from "../../graphql/server.js";

export interface GraphqlRouteDeps {
  readDb: Kysely<DB>;
  db: Kysely<DB>;
  storage: BlobStorage;
  cursorKeys: CursorSigningKey[];
  clock: Clock;
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
  });

  router.use(GRAPHQL_ENDPOINT, yoga);
  return router;
}
