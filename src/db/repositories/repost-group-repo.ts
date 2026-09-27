import type { Kysely } from "kysely";
import type { DB } from "../schema.js";

export const repostGroupRepo = {
  async findByIds(db: Kysely<DB>, ids: number[]) {
    if (ids.length === 0) return [];
    return db.selectFrom("repost_groups").selectAll().where("id", "in", ids).execute();
  },

  /**
   * A member's own repost_group_id column already points at its group
   * (spec §5 media.repost_group_id) — this exists only so resolvers have
   * one place to fetch group members, paginated the same way the main
   * feed is (keyset on ig_timestamp, id), reposts NOT excluded here since
   * the whole point of RepostGroup.members is to show them.
   */
  async members(
    db: Kysely<DB>,
    groupId: number,
    limit: number,
    after: { t: Date; id: number } | null
  ) {
    let query = db
      .selectFrom("media")
      .selectAll()
      .where("repost_group_id", "=", groupId)
      .orderBy("ig_timestamp", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);

    if (after) {
      query = query.where((eb) =>
        eb.or([
          eb("ig_timestamp", "<", after.t),
          eb.and([eb("ig_timestamp", "=", after.t), eb("id", "<", after.id)]),
        ])
      );
    }

    return query.execute();
  },
};
