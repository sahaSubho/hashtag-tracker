import type { ColumnType, Generated } from "kysely";

export interface HashtagsTable {
  id: Generated<number>;
  name: string;
  ig_hashtag_id: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface DB {
  hashtags: HashtagsTable;
}
