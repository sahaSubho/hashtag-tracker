import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import { makeDb } from "./pool.js";
import { loadEnvFile } from "../config/load-env-file.js";

export interface RoleCredentials {
  migratorPassword: string;
  appPassword: string;
  graphqlPassword: string;
}

/**
 * One-time local database setup (`npm run db:setup`), run as a Postgres
 * superuser BEFORE the first `npm run migrate`. Migration 0001 creates the
 * three roles NOLOGIN on purpose — migrations never hold passwords — so
 * something outside them has to let each role log in:
 *
 * - tracker_app / tracker_graphql: LOGIN with the passwords from .env.
 * - tracker_migrator: LOGIN, owner of the database (so it can create the
 *   schema and the trusted pgcrypto extension), and CREATEROLE with ADMIN
 *   on the other two roles (so migration 0001 can set tracker_graphql's
 *   statement_timeout without being a superuser).
 *
 * Idempotent. Local/dev only: in production the roles' credentials belong
 * to the RDS/Secrets Manager setup (spec §15), not a CLI.
 */
export async function setupRoles(admin: Kysely<unknown>, database: string, creds: RoleCredentials): Promise<void> {
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
  `.execute(admin);

  // ALTER ROLE ... PASSWORD cannot take a bind parameter; sql.lit quotes
  // and escapes the value (' -> ''). Values come from the operator's own .env.
  await sql`ALTER ROLE tracker_migrator WITH LOGIN CREATEROLE PASSWORD ${sql.lit(creds.migratorPassword)}`.execute(admin);
  await sql`ALTER ROLE tracker_app WITH LOGIN PASSWORD ${sql.lit(creds.appPassword)}`.execute(admin);
  await sql`ALTER ROLE tracker_graphql WITH LOGIN PASSWORD ${sql.lit(creds.graphqlPassword)}`.execute(admin);
  await sql`GRANT tracker_app, tracker_graphql TO tracker_migrator WITH ADMIN OPTION`.execute(admin);
  await sql`ALTER DATABASE ${sql.id(database)} OWNER TO tracker_migrator`.execute(admin);
}

const EXPECTED_USERS = {
  DATABASE_URL: "tracker_app",
  DATABASE_URL_READONLY: "tracker_graphql",
  DATABASE_URL_MIGRATOR: "tracker_migrator",
} as const;

/** Pulls each role's password, and the database name, out of the .env connection strings. */
export function credentialsFromEnv(env: Record<string, string | undefined>): {
  database: string;
  creds: RoleCredentials;
} {
  const password = (name: keyof typeof EXPECTED_USERS): string => {
    const raw = env[name];
    if (!raw) throw new Error(`${name} must be set`);
    const url = new URL(raw);
    if (decodeURIComponent(url.username) !== EXPECTED_USERS[name]) {
      throw new Error(`${name} must connect as ${EXPECTED_USERS[name]} (got "${url.username}")`);
    }
    if (!url.password) throw new Error(`${name} must include a password`);
    return decodeURIComponent(url.password);
  };

  const creds: RoleCredentials = {
    appPassword: password("DATABASE_URL"),
    graphqlPassword: password("DATABASE_URL_READONLY"),
    migratorPassword: password("DATABASE_URL_MIGRATOR"),
  };
  const database = decodeURIComponent(new URL(env.DATABASE_URL!).pathname.slice(1));
  return { database, creds };
}

async function main(): Promise<void> {
  loadEnvFile();
  if (process.env.NODE_ENV === "production") {
    throw new Error("db:setup is for local development only");
  }
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminUrl) throw new Error("DATABASE_URL_ADMIN (a superuser connection string) must be set");

  const { database, creds } = credentialsFromEnv(process.env);
  const admin = makeDb(adminUrl) as unknown as Kysely<unknown>;
  try {
    await setupRoles(admin, database, creds);
    console.log(`Roles ready for database "${database}". Next: npm run migrate`);
  } finally {
    await admin.destroy();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
