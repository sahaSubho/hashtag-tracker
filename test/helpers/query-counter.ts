import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "../../src/db/schema.js";

/**
 * A Kysely instance backed by a pg.Pool whose SQL statements are counted.
 * Used to prove "N posts with assets and repost groups run at most K SQL
 * statements" with an actual count, not an assumption about DataLoader
 * batching working correctly.
 *
 * Kysely's PostgresDriver never calls `pool.query()` directly — it always
 * checks out a client via `pool.connect()` and calls `.query()` on THAT
 * client instance. Wrapping `pool.query` (an earlier version of this
 * helper) intercepts nothing and silently always reports 0, which made
 * count assertions pass vacuously. This wraps `pool.connect()` instead,
 * returning a client whose own `query` method is what gets counted.
 *
 * `pg.Pool` reuses idle clients across separate `connect()` calls within
 * one pool (Kysely acquires/releases a connection per statement), so a
 * naive wrap-on-every-connect would re-wrap an already-wrapped client's
 * `query`, double-counting (and, worse, double-EXECUTING — the original
 * captured by the second wrap is itself a wrapper, and the query fires
 * once per layer) every statement that happened to reuse a client. The
 * WeakSet below wraps each distinct client object exactly once.
 */
export function makeCountingDb(
  connectionString: string
): { db: Kysely<DB>; count(): number; statements(): string[] } {
  let count = 0;
  const statements: string[] = [];
  const pool = new pg.Pool({ connectionString });
  const originalConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;

  const wrappedClients = new WeakSet<object>();
  pool.connect = (async () => {
    const client = await originalConnect();
    if (wrappedClients.has(client)) {
      return client;
    }
    wrappedClients.add(client);
    const originalClientQuery = client.query.bind(client) as (...a: unknown[]) => unknown;
    client.query = ((...queryArgs: unknown[]) => {
      count++;
      const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : (queryArgs[0] as { text?: string })?.text;
      if (sql) statements.push(sql);
      return originalClientQuery(...queryArgs);
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;

  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, count: () => count, statements: () => statements };
}
