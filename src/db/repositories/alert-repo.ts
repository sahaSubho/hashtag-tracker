import type { Kysely } from "kysely";
import type { DB, AlertState } from "../schema.js";

export const alertRepo = {
  async findByKey(db: Kysely<DB>, alertKey: string) {
    return db.selectFrom("alerts").selectAll().where("alert_key", "=", alertKey).executeTakeFirst();
  },

  async upsertFiring(db: Kysely<DB>, alertKey: string, now: Date, details: unknown) {
    await db
      .insertInto("alerts")
      .values({
        alert_key: alertKey,
        state: "firing",
        fired_at: now,
        details: JSON.stringify(details ?? {}),
      })
      .onConflict((oc) =>
        oc.column("alert_key").doUpdateSet({
          state: "firing" as AlertState,
          details: JSON.stringify(details ?? {}),
        })
      )
      .execute();
  },

  async markResolved(db: Kysely<DB>, alertKey: string, now: Date) {
    await db
      .updateTable("alerts")
      .set({ state: "resolved", resolved_at: now })
      .where("alert_key", "=", alertKey)
      .execute();
  },
};
