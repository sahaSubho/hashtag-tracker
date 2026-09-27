import type { Kysely } from "kysely";
import type { DB } from "../schema.js";

export const heartbeatRepo = {
  async checkIn(db: Kysely<DB>, component: string, now: Date): Promise<void> {
    await db
      .insertInto("heartbeats")
      .values({ component, last_seen_at: now })
      .onConflict((oc) => oc.column("component").doUpdateSet({ last_seen_at: now }))
      .execute();
  },

  async lastSeen(db: Kysely<DB>, component: string): Promise<Date | null> {
    const row = await db
      .selectFrom("heartbeats")
      .select("last_seen_at")
      .where("component", "=", component)
      .executeTakeFirst();
    return row?.last_seen_at ?? null;
  },
};
