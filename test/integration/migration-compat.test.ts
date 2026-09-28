import { describe, it, expect } from "vitest";
import type { Kysely } from "kysely";
import { withTestDb } from "../helpers/pg.js";
import type { DB } from "../../src/db/schema.js";
import { SCHEMA_BASELINE, type SchemaColumn } from "../fixtures/schema-baseline.js";

interface CurrentColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
}

async function currentColumns(db: Kysely<DB>): Promise<SchemaColumn[]> {
  const rows = (await db
    .selectFrom("information_schema.columns" as any)
    .select(["table_name" as any, "column_name" as any, "data_type" as any, "is_nullable" as any])
    .where("table_schema" as any, "=", "public")
    .where("table_name" as any, "not like", "kysely_%") // Kysely's own migration bookkeeping tables, not app schema
    .execute()) as unknown as CurrentColumn[];

  return rows.map((r) => ({
    table: r.table_name,
    column: r.column_name,
    dataType: r.data_type,
    nullable: r.is_nullable === "YES",
  }));
}

function columnKey(c: { table: string; column: string }): string {
  return `${c.table}.${c.column}`;
}

/**
 * Guards the automatable core of "migrations must be backward-compatible"
 * (spec §15.1): a rolling deploy briefly runs old and new application code
 * against the SAME database, so a migration that removes a column or
 * changes its type out from under running old code would break it mid-
 * deploy. This can't catch every kind of incompatibility (a column that's
 * still present but whose meaning changed, for instance), but it catches
 * the two mechanical, unambiguous cases: a column disappearing, or its
 * declared SQL type changing.
 *
 * A genuinely intentional destructive change (dropping a column in a
 * later release, once nothing reads it) updates test/fixtures/schema-
 * baseline.ts to match and explains why in that migration's own comment
 * — this test is a prompt to make that decision explicitly, not a rule
 * that no schema may ever shrink.
 */
describe("migration compatibility (spec §15.1)", () => {
  it("every column in the baseline still exists, with the same declared type", async () => {
    await withTestDb(async (db) => {
      const current = await currentColumns(db);
      const currentByKey = new Map(current.map((c) => [columnKey(c), c]));

      const missing: string[] = [];
      const retyped: string[] = [];

      for (const baseline of SCHEMA_BASELINE) {
        const key = columnKey(baseline);
        const found = currentByKey.get(key);
        if (!found) {
          missing.push(key);
          continue;
        }
        if (found.dataType !== baseline.dataType) {
          retyped.push(`${key}: was ${baseline.dataType}, now ${found.dataType}`);
        }
      }

      if (missing.length > 0 || retyped.length > 0) {
        const details = [
          missing.length > 0 ? `Removed columns (breaks a rolling deploy's old code): ${missing.join(", ")}` : null,
          retyped.length > 0 ? `Retyped columns (breaks a rolling deploy's old code): ${retyped.join("; ")}` : null,
          "If this is an intentional, reviewed breaking change, update test/fixtures/schema-baseline.ts and document why in the migration.",
        ]
          .filter(Boolean)
          .join("\n");
        expect.fail(details);
      }
    });
  });

  it("a column may become nullable (safe) but not become non-nullable without a default (unsafe for old code)", async () => {
    await withTestDb(async (db) => {
      const current = await currentColumns(db);
      const currentByKey = new Map(current.map((c) => [columnKey(c), c]));

      const nowRequired: string[] = [];
      for (const baseline of SCHEMA_BASELINE) {
        if (!baseline.nullable) continue; // only checking columns that were nullable before
        const found = currentByKey.get(columnKey(baseline));
        if (found && !found.nullable) {
          nowRequired.push(columnKey(baseline));
        }
      }

      if (nowRequired.length > 0) {
        expect.fail(
          `Columns that were nullable are now NOT NULL: ${nowRequired.join(", ")} — old application code ` +
            "running during a rolling deploy may insert rows without these columns and would start failing."
        );
      }
    });
  });
});
