import type { Kysely } from "kysely";
import type { DB } from "../schema.js";

export interface HashtagRow {
  id: number;
  name: string;
  igHashtagId: string;
}

export const hashtagRepo = {
  /**
   * Returns the hashtag row for `name`, inserting it with `igHashtagId` if
   * it doesn't exist yet. Used by bootstrap so ig_hashtag_search only ever
   * needs to run once (spec §6.1).
   */
  async upsertOnce(
    db: Kysely<DB>,
    name: string,
    igHashtagId: string
  ): Promise<HashtagRow> {
    const existing = await db
      .selectFrom("hashtags")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();
    if (existing) {
      return { id: existing.id, name: existing.name, igHashtagId: existing.ig_hashtag_id };
    }

    const inserted = await db
      .insertInto("hashtags")
      .values({ name, ig_hashtag_id: igHashtagId })
      .onConflict((oc) => oc.column("name").doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) {
      return { id: inserted.id, name: inserted.name, igHashtagId: inserted.ig_hashtag_id };
    }

    // Lost a race with a concurrent insert; read back the row.
    const row = await db
      .selectFrom("hashtags")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirstOrThrow();
    return { id: row.id, name: row.name, igHashtagId: row.ig_hashtag_id };
  },

  async findByName(db: Kysely<DB>, name: string): Promise<HashtagRow | null> {
    const row = await db
      .selectFrom("hashtags")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();
    if (!row) return null;
    return { id: row.id, name: row.name, igHashtagId: row.ig_hashtag_id };
  },
};
