import { GraphQLScalarType, Kind } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { BlobStorage } from "../ports/blob-storage.js";
import type { CursorSigningKey } from "../domain/cursor.js";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";
import { createLoaders } from "./loaders.js";
import type { GraphqlContext } from "./resolvers.js";

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

export interface GraphqlServerDeps {
  readDb: Kysely<DB>;
  storage: BlobStorage;
  cursorKeys: CursorSigningKey[];
  /** Path the yoga server is mounted at, for its own introspection UI links. Default "/graphql". */
  graphqlEndpoint?: string;
}

/**
 * Builds the GraphQL dashboard server (spec §10). Deliberately unbounded
 * for now: no depth/cost/alias limits, no persisted-operation allowlist, no
 * response cache, no cost-based rate limiting, introspection left on. All
 * of that is P3-04's job — this task's scope is a *correct* server whose
 * resolvers share the REST code path and are proven to avoid N+1 queries.
 * Authentication (an admin/dashboard:read-scoped API key) is enforced by
 * the caller mounting this at the HTTP layer, not inside this function.
 */
export function createGraphqlServer(deps: GraphqlServerDeps) {
  const schema = createSchema({
    typeDefs,
    resolvers: { ...resolvers, DateTime: dateTimeScalar },
  });

  return createYoga({
    schema,
    graphqlEndpoint: deps.graphqlEndpoint ?? "/graphql",
    context: (): GraphqlContext => ({
      readDb: deps.readDb,
      loaders: createLoaders(deps.readDb, deps.storage),
      cursorKeys: deps.cursorKeys,
    }),
  });
}
