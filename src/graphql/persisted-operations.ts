import { createHash } from "node:crypto";
import { parse, print, type DocumentNode } from "graphql";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The dashboard's own registered queries (spec §10). In a real deployment
 * these would be populated by the dashboard's build process (each query it
 * sends, hashed); here they're the queries this repo's own test suite and
 * documented dashboard usage send.
 *
 * Hashed by sha256 of the PARSED-then-PRINTED operation, not the raw
 * source string: the enforcement plugin (persisted-operations-plugin.ts)
 * hashes `print(args.document)` — the AST graphql-yoga already parsed —
 * so registering by raw source would silently never match once any
 * whitespace/formatting differed (which it always does between a
 * hand-written query and its parsed-and-reprinted form). Parsing here too
 * keeps registration and enforcement using the exact same normalization.
 */
export function hashOperation(query: string): string {
  return sha256(print(parse(query)));
}

/** Same normalization as hashOperation, for a document graphql-yoga already parsed — avoids reparsing it. */
export function hashParsedOperation(document: DocumentNode): string {
  return sha256(print(document));
}

const REGISTERED_QUERIES: string[] = [
  `{ posts(first: 50) { edges { node { id igMediaId caption mediaType permalink postedAt likeCount commentsCount assets { position kind status contentType url } repostGroup { id size totalLikes totalComments } } cursor } pageInfo { endCursor hasNextPage } } }`,
];

export const PERSISTED_OPERATION_HASHES = new Set(REGISTERED_QUERIES.map(hashOperation));

/** Registers an operation as allowed in production — used by tests that need their own query to pass the allowlist. */
export function registerOperation(query: string): void {
  PERSISTED_OPERATION_HASHES.add(hashOperation(query));
}
