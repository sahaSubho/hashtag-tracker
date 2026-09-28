import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, sql } from "kysely";
import pg from "pg";
import { makeDb } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { DB } from "../../src/db/schema.js";

let containerPromise: Promise<StartedPostgreSqlContainer> | undefined;
let templateReadyPromise: Promise<{ baseUrl: string; adminUrl: string }> | undefined;

const TEMPLATE_DB = "template_migrated";

function getContainer(): Promise<StartedPostgreSqlContainer> {
  containerPromise ??= new PostgreSqlContainer("postgres:16")
    .withDatabase("hashtag_tracker_test")
    .withUsername("postgres")
    .withPassword("postgres")
    // Default max_connections (100) turned out to be tight once
    // isolate: false (vitest.config.ts) made every test file in the
    // suite share this one container's connection budget instead of
    // each file getting its own container — occasional 60s timeouts
    // (not wrong results, just starvation) showed up on ordinary
    // single-connection tests under full-suite load. Raised well above
    // what this suite plausibly needs concurrently.
    .withCommand(["postgres", "-c", "max_connections=300"])
    .start();
  return containerPromise;
}

/**
 * Starts (once per test file, lazily) a Postgres container, migrates a
 * template database, then for each call clones a fresh database from that
 * template. Cloning is far cheaper than re-running every migration per
 * test, while still giving every test a fully isolated, freshly migrated
 * database — no shared state between tests.
 */
async function ensureTemplate(): Promise<{ baseUrl: string; adminUrl: string }> {
  if (templateReadyPromise) return templateReadyPromise;

  templateReadyPromise = (async () => {
    const container = await getContainer();
    const adminUrl = container.getConnectionUri();
    const parsed = new URL(adminUrl);

    // Create the template database, then run migrations against it.
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE ${TEMPLATE_DB}`);
    } finally {
      await adminPool.end();
    }

    const templateUrl = new URL(adminUrl);
    templateUrl.pathname = `/${TEMPLATE_DB}`;
    const templateDb = makeDb(templateUrl.toString());
    try {
      await runMigrations(templateDb as unknown as Kysely<unknown>);
    } finally {
      await templateDb.destroy();
    }

    // Postgres requires no other connections to a database when it is used
    // as a CREATE DATABASE ... TEMPLATE source, and marking it as a template
    // additionally prevents accidental connections/drops.
    const adminPool2 = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool2.query(`ALTER DATABASE ${TEMPLATE_DB} WITH is_template TRUE`);
    } finally {
      await adminPool2.end();
    }

    return { baseUrl: adminUrl, adminUrl: parsed.toString() };
  })();

  return templateReadyPromise;
}

let cloneCounter = 0;

/**
 * Runs `fn` against a fresh, fully migrated Postgres database. The database
 * is created by cloning the migrated template and is dropped afterwards.
 * The second argument to `fn` is that database's own connection string, for
 * tests that need to open a second, independent pool against the same
 * database (e.g. proving two pools don't share a connection queue).
 */
export async function withTestDb<T>(
  fn: (db: Kysely<DB>, connectionString: string) => Promise<T>
): Promise<T> {
  const { baseUrl } = await ensureTemplate();
  const dbName = `t_${Date.now()}_${cloneCounter++}`;

  const adminPool = new pg.Pool({ connectionString: baseUrl });
  try {
    await adminPool.query(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await adminPool.end();
  }

  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;
  const connectionString = dbUrl.toString();
  const db = makeDb(connectionString);

  try {
    return await fn(db, connectionString);
  } finally {
    await db.destroy();
    const cleanupPool = new pg.Pool({ connectionString: baseUrl });
    try {
      await cleanupPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      );
      await cleanupPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } finally {
      await cleanupPool.end();
    }
  }
}

/**
 * Runs `fn` with a Kysely instance whose statements execute as the
 * tracker_graphql role, inside one transaction using `SET LOCAL ROLE` (so
 * the role switch never leaks to other statements on the pool). Since
 * tracker_graphql is NOLOGIN (spec §5) — deliberately, so no test-only
 * password needs to exist anywhere — this is how tests get a connection
 * that genuinely runs under that role's real Postgres privileges, without
 * managing separate credentials. Verified directly against postgres:16
 * that a real INSERT under SET ROLE tracker_graphql fails with
 * "permission denied", not merely a grants-metadata check.
 */
export async function withGraphqlRole<T>(
  db: Kysely<DB>,
  fn: (roleDb: Kysely<DB>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`SET LOCAL ROLE tracker_graphql`.execute(tx);
    return fn(tx as unknown as Kysely<DB>);
  });
}
