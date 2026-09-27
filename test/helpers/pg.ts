import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely } from "kysely";
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
 */
export async function withTestDb<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
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
  const db = makeDb(dbUrl.toString());

  try {
    return await fn(db);
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
