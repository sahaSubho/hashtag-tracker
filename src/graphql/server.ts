import { GraphQLError, GraphQLScalarType, Kind } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import { EnvelopArmorPlugin } from "@escape.tech/graphql-armor";
import { createGraphQLError } from "@graphql-tools/utils";
import type { Request as ExpressRequest } from "express";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import type { CursorSigningKey } from "../domain/cursor.js";
import type { RateLimitStore } from "../ports/rate-limit-store.js";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";
import { createLoaders } from "./loaders.js";
import type { GraphqlContext } from "./resolvers.js";
import { rejectOversizedFirstPlugin } from "./plugins/reject-oversized-first.js";
import { persistedOperationsPlugin } from "./plugins/persisted-operations-plugin.js";
import { disableIntrospectionPlugin } from "./plugins/disable-introspection-plugin.js";
import { costRateLimitPlugin } from "./plugins/cost-rate-limit-plugin.js";
import { responseCachePlugin, ResponseCache } from "./response-cache.js";

const dateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "ISO-8601 date-time string",
  serialize(value) {
    return value instanceof Date ? value.toISOString() : String(value);
  },
  parseValue(value) {
    return new Date(value as string);
  },
  parseLiteral(ast) {
    return ast.kind === Kind.STRING ? new Date(ast.value) : null;
  },
});

const DEFAULT_COST_PER_MIN = 10_000;
const MAX_DEPTH = 5;
const MAX_ALIASES = 10;
const MAX_COST = 1000;

/**
 * Yoga's own default error mask (used whenever `maskedErrors` is set but
 * no `maskError` function is supplied) masks EVERY error unconditionally,
 * not only unexpected ones — unlike @envelop/core's bare useMaskedErrors,
 * which passes an already-well-formed GraphQLError straight through. That
 * default would mask armor's depth/alias/cost rejections, the persisted-
 * operation and introspection rejections, and the rate-limit error too,
 * which are all intentional, well-formed GraphQLErrors this app WANTS the
 * client to see verbatim (their extensions.code is how a client tells
 * "over budget" from "malformed request" apart) — masking them would
 * defeat the point of giving them distinct error codes at all. So this
 * app supplies its own maskError: pass through any error that is already
 * a GraphQLError (armor's rejections, this app's own plugin rejections),
 * and mask only genuinely unexpected exceptions (e.g. a resolver bug),
 * and only outside dev.
 */
function maskError(error: unknown, message: string, isDev?: boolean): Error {
  if (error instanceof GraphQLError) {
    return error;
  }
  if (isDev) {
    const detail = error instanceof Error ? error.message : String(error);
    return createGraphQLError(detail, { originalError: error instanceof Error ? error : undefined });
  }
  return createGraphQLError(message, { extensions: { unexpected: true } });
}

export interface GraphqlServerDeps {
  readDb: Kysely<DB>;
  storage: BlobStorage;
  cursorKeys: CursorSigningKey[];
  /** Path the yoga server is mounted at, for its own introspection UI links. Default "/graphql". */
  graphqlEndpoint?: string;
  /** Default "development" — production turns on the persisted-operation allowlist, disables introspection, and masks thrown errors. */
  nodeEnv?: string;
  /** Backs the per-API-key cost budget. Omitted disables that check (e.g. most unit tests). */
  rateLimitStore?: RateLimitStore;
  costPerMin?: number;
  /** Exposed for tests that need to force a cache clear without waiting 30s. */
  responseCache?: ResponseCache;
}

/**
 * Builds the GraphQL dashboard server (spec §10, hardened per P3-04):
 * depth/alias/cost limits and a block-field-suggestions guard via
 * graphql-armor, a hard reject (not silent clamp) on any `first` over 50,
 * a persisted-operation allowlist and disabled introspection in
 * production, masked resolver errors outside dev, a 30s response cache,
 * and a per-API-key cost-based rate limit reusing the REST rate-limit
 * port. Resolvers themselves are unchanged from P3-03 — this task is
 * entirely about what surrounds them.
 */
export function createGraphqlServer(deps: GraphqlServerDeps) {
  const nodeEnv = deps.nodeEnv ?? "development";
  const cache = deps.responseCache ?? new ResponseCache();

  const schema = createSchema({
    typeDefs,
    resolvers: { ...resolvers, DateTime: dateTimeScalar },
  });

  const armor = EnvelopArmorPlugin({
    maxDepth: { n: MAX_DEPTH },
    maxAliases: { n: MAX_ALIASES },
    costLimit: { maxCost: MAX_COST },
    blockFieldSuggestion: { enabled: true },
  });

  const plugins = [
    armor,
    rejectOversizedFirstPlugin(),
    persistedOperationsPlugin(nodeEnv),
    disableIntrospectionPlugin(nodeEnv),
    responseCachePlugin(cache),
  ];

  if (deps.rateLimitStore) {
    plugins.push(costRateLimitPlugin(deps.rateLimitStore, deps.costPerMin ?? DEFAULT_COST_PER_MIN));
  }

  return createYoga({
    schema,
    graphqlEndpoint: deps.graphqlEndpoint ?? "/graphql",
    maskedErrors: { isDev: nodeEnv !== "production", maskError, errorMessage: "Unexpected error." },
    plugins,
    context: ({ req }: { req?: ExpressRequest }): GraphqlContext & { apiKeyId?: string } => ({
      readDb: deps.readDb,
      loaders: createLoaders(deps.readDb, deps.storage),
      cursorKeys: deps.cursorKeys,
      apiKeyId: req?.apiKeyId,
    }),
  });
}
