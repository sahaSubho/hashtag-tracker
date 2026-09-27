import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./schema.js";

// node-postgres returns int8/bigserial (OID 20) as strings by default, to
// avoid silently losing precision above Number.MAX_SAFE_INTEGER. Every id
// column in this schema is bigserial and is typed as `number` throughout
// the codebase (media ids, asset ids, etc.), and none of our counters will
// ever approach that limit, so parsing them as numbers here is safe and
// keeps every call site's `number` typing honest instead of quietly
// returning strings that break equality checks, cursor encoding, and JSON
// consumers expecting a number.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (value: string) => Number(value));

export function makeDb(connectionString: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });
}
