import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_roles.js";
import * as m0002 from "./0002_hashtags.js";

/**
 * Explicit migration registry, in place of Kysely's FileMigrationProvider.
 *
 * FileMigrationProvider dynamically imports each migration file by path
 * using Node's native ESM loader, which happens outside our test runner's
 * (vitest/tsx) module transform pipeline for that specific import call. That
 * breaks relative imports of other .ts source files from inside a migration
 * (e.g. importing "../grants.js" from a .ts file has no matching .js on
 * disk). Importing every migration module statically here lets the normal
 * loader chain handle resolution, and keeps the migration list explicit and
 * type-checked. New migrations must be added to this list.
 */
export const migrations: Record<string, Migration> = {
  "0001_roles": m0001,
  "0002_hashtags": m0002,
};
