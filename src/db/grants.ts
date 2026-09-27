import { sql, type Kysely } from "kysely";

/**
 * Grants the standard app-role privileges (SELECT/INSERT/UPDATE/DELETE, no
 * schema changes) on a table to tracker_app. Called by every migration that
 * creates an application table. A no-op before migration 0002 has created
 * the role would fail, so 0002 must run before any table migration that
 * calls this — which is enforced simply by migration ordering (0001 also
 * calls this, but tracker_app is created in 0002; see note in 0002).
 */
export async function grantAppTable(db: Kysely<unknown>, tableName: string): Promise<void> {
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${sql.ref(tableName)} TO tracker_app`.execute(
    db
  );
}

/** Grants read-only access to a table to the tracker_graphql role. */
export async function grantGraphqlTable(db: Kysely<unknown>, tableName: string): Promise<void> {
  await sql`GRANT SELECT ON TABLE ${sql.ref(tableName)} TO tracker_graphql`.execute(db);
}
