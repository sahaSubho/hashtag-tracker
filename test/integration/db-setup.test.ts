import { describe, it, expect } from "vitest";
import { sql, type Kysely } from "kysely";
import { withTestDb } from "../helpers/pg.js";
import { makeDb } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { setupRoles, credentialsFromEnv } from "../../src/db/setup-roles.js";
import { hashtagRepo } from "../../src/db/repositories/hashtag-repo.js";

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function withCredentials(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

/**
 * The documented fresh-install path, end to end, on a brand-new database:
 * `npm run db:setup` (superuser) → `npm run migrate` as tracker_migrator →
 * the app as tracker_app, each logging in with its own password. Before
 * db:setup existed, the roles were NOLOGIN with no password, so the
 * .env.example connection strings could never work.
 */
describe("setupRoles (npm run db:setup)", () => {
  it("lets a fresh database be migrated by tracker_migrator and used by tracker_app", async () => {
    await withTestDb(async (_db, testDbUrl) => {
      const database = `setup_${Math.random().toString(36).slice(2, 10)}`;
      const adminUrl = withDatabase(testDbUrl, "postgres");
      const creds = { migratorPassword: "mig 'pw", appPassword: "app-pw", graphqlPassword: "gql-pw" };

      const admin = makeDb(adminUrl) as unknown as Kysely<unknown>;
      await sql`CREATE DATABASE ${sql.id(database)}`.execute(admin);
      try {
        await setupRoles(admin, database, creds);

        const freshUrl = withDatabase(testDbUrl, database);
        const migrator = makeDb(withCredentials(freshUrl, "tracker_migrator", creds.migratorPassword));
        try {
          await runMigrations(migrator as unknown as Kysely<unknown>);
        } finally {
          await migrator.destroy();
        }

        const app = makeDb(withCredentials(freshUrl, "tracker_app", creds.appPassword));
        try {
          const row = await hashtagRepo.upsertOnce(app, "matcha", "17843");
          expect(row.name).toBe("matcha");
          await expect(sql`CREATE TABLE nope (id int)`.execute(app)).rejects.toThrow(/permission denied/i);
        } finally {
          await app.destroy();
        }

        const graphql = makeDb(withCredentials(freshUrl, "tracker_graphql", creds.graphqlPassword));
        try {
          const rows = await graphql.selectFrom("media_assets").selectAll().execute();
          expect(rows).toEqual([]);
        } finally {
          await graphql.destroy();
        }
      } finally {
        await sql`DROP DATABASE IF EXISTS ${sql.id(database)} WITH (FORCE)`.execute(admin);
        await admin.destroy();
      }
    });
  });

  it("is safe to run twice", async () => {
    await withTestDb(async (_db, testDbUrl) => {
      const database = `setup_${Math.random().toString(36).slice(2, 10)}`;
      const admin = makeDb(withDatabase(testDbUrl, "postgres")) as unknown as Kysely<unknown>;
      await sql`CREATE DATABASE ${sql.id(database)}`.execute(admin);
      try {
        const creds = { migratorPassword: "a", appPassword: "b", graphqlPassword: "c" };
        await setupRoles(admin, database, creds);
        await expect(setupRoles(admin, database, creds)).resolves.toBeUndefined();
      } finally {
        await sql`DROP DATABASE IF EXISTS ${sql.id(database)} WITH (FORCE)`.execute(admin);
        await admin.destroy();
      }
    });
  });
});

describe("credentialsFromEnv", () => {
  const env = {
    DATABASE_URL: "postgres://tracker_app:app_pw@localhost:5432/hashtag_tracker",
    DATABASE_URL_READONLY: "postgres://tracker_graphql:gql_pw@localhost:5432/hashtag_tracker",
    DATABASE_URL_MIGRATOR: "postgres://tracker_migrator:mig%40pw@localhost:5432/hashtag_tracker",
  };

  it("reads each role's password (URL-decoded) and the database name from the .env URLs", () => {
    expect(credentialsFromEnv(env)).toEqual({
      database: "hashtag_tracker",
      creds: { appPassword: "app_pw", graphqlPassword: "gql_pw", migratorPassword: "mig@pw" },
    });
  });

  it("rejects a URL whose user is not the expected role", () => {
    expect(() => credentialsFromEnv({ ...env, DATABASE_URL: "postgres://postgres:x@localhost/hashtag_tracker" })).toThrow(
      /DATABASE_URL must connect as tracker_app/
    );
  });

  it("rejects a missing URL", () => {
    expect(() => credentialsFromEnv({ ...env, DATABASE_URL_READONLY: undefined })).toThrow(/DATABASE_URL_READONLY/);
  });
});
