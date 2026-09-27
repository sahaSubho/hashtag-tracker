import { sql, type Kysely } from "kysely";

/**
 * Creates the three database roles used throughout the app (spec §5):
 * - tracker_migrator: owns the schema, runs migrations only
 * - tracker_app: SELECT/INSERT/UPDATE/DELETE on app tables, no schema changes
 * - tracker_graphql: read-only, with a short statement_timeout for dashboard queries
 *
 * Must run before any migration that grants privileges to these roles.
 * CREATE ROLE has no IF NOT EXISTS, so we guard with a DO block to keep the
 * migration idempotent (safe to re-run against a database where the roles
 * already exist, e.g. a template database cloned per test).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tracker_migrator') THEN
        CREATE ROLE tracker_migrator NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tracker_app') THEN
        CREATE ROLE tracker_app NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tracker_graphql') THEN
        CREATE ROLE tracker_graphql NOLOGIN;
      END IF;
    END
    $$;
  `.execute(db);

  await sql`ALTER ROLE tracker_graphql SET statement_timeout = '2s'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP ROLE IF EXISTS tracker_app`.execute(db);
  await sql`DROP ROLE IF EXISTS tracker_graphql`.execute(db);
  await sql`DROP ROLE IF EXISTS tracker_migrator`.execute(db);
}
