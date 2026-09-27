import type { Migration } from "kysely/migration";
import * as m0001 from "./0001_roles.js";
import * as m0002 from "./0002_hashtags.js";
import * as m0003 from "./0003_media.js";
import * as m0004 from "./0004_media_hashtags.js";
import * as m0005 from "./0005_media_assets.js";
import * as m0006 from "./0006_sync_runs.js";
import * as m0007 from "./0007_engagement_snapshots.js";
import * as m0008 from "./0008_repost_groups.js";
import * as m0009 from "./0009_outbox.js";
import * as m0010 from "./0010_rejected_items.js";
import * as m0011 from "./0011_dead_letters.js";
import * as m0012 from "./0012_alerts.js";
import * as m0013 from "./0013_api_keys.js";
import * as m0014 from "./0014_heartbeats.js";

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
  "0003_media": m0003,
  "0004_media_hashtags": m0004,
  "0005_media_assets": m0005,
  "0006_sync_runs": m0006,
  "0007_engagement_snapshots": m0007,
  "0008_repost_groups": m0008,
  "0009_outbox": m0009,
  "0010_rejected_items": m0010,
  "0011_dead_letters": m0011,
  "0012_alerts": m0012,
  "0013_api_keys": m0013,
  "0014_heartbeats": m0014,
};
