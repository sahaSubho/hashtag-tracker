import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "../../src/db/schema.js";

/**
 * A Kysely instance backed by a pg.Pool whose `query` calls are counted.
 * Used to prove "N posts with assets and repost groups run at most K SQL
 * statements" with an actual count, not an assumption about DataLoader
 * batching working correctly.
 */
export function makeCountingDb(connectionString: string): { db: Kysely<DB>; count(): number } {
  let count = 0;
  const pool = new pg.Pool({ connectionString });
  const originalQuery = pool.query.bind(pool);
  // @ts-expect-error -- intentionally overriding pg.Pool#query's overloaded signature to count calls
  pool.query = (...args: Parameters<typeof originalQuery>) => {
    count++;
    return originalQuery(...args);
  };

  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, count: () => count };
}
