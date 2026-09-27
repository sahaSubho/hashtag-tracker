import type { Kysely } from "kysely";
import type { DB } from "../schema.js";

export interface CreateApiKeyInput {
  keyId: string;
  hash: string;
  name: string;
  scopes: string[];
  expiresAt?: Date | null;
}

export const apiKeyRepo = {
  async create(db: Kysely<DB>, input: CreateApiKeyInput): Promise<void> {
    await db
      .insertInto("api_keys")
      .values({
        key_id: input.keyId,
        hash: input.hash,
        name: input.name,
        scopes: input.scopes,
        expires_at: input.expiresAt ?? null,
      })
      .execute();
  },

  async findByKeyId(db: Kysely<DB>, keyId: string) {
    return db.selectFrom("api_keys").selectAll().where("key_id", "=", keyId).executeTakeFirst();
  },

  async revoke(db: Kysely<DB>, keyId: string, now: Date): Promise<void> {
    await db.updateTable("api_keys").set({ revoked_at: now }).where("key_id", "=", keyId).execute();
  },

  async touchLastUsed(db: Kysely<DB>, keyId: string, now: Date): Promise<void> {
    await db.updateTable("api_keys").set({ last_used_at: now }).where("key_id", "=", keyId).execute();
  },
};
