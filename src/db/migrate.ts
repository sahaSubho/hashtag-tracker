import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { Migrator, type MigrationResultSet, type MigrationProvider } from "kysely/migration";
import { makeDb } from "./pool.js";
import { migrations } from "./migrations/index.js";

const staticMigrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};

export function makeMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: staticMigrationProvider,
  });
}

export async function runMigrations(db: Kysely<unknown>): Promise<MigrationResultSet> {
  const migrator = makeMigrator(db);
  const result = await migrator.migrateToLatest();
  if (result.error) {
    throw result.error;
  }
  return result;
}

async function main(): Promise<void> {
  const direction = process.argv[2];
  const connectionString =
    process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_MIGRATOR or DATABASE_URL must be set");
  }

  const db = makeDb(connectionString);
  const migrator = makeMigrator(db as unknown as Kysely<unknown>);

  const result =
    direction === "down"
      ? await migrator.migrateDown()
      : await migrator.migrateToLatest();

  for (const r of result.results ?? []) {
    console.log(`${r.status}: ${r.migrationName}`);
  }
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  }

  await db.destroy();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
