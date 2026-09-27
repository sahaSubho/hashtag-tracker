import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { Clock } from "../ports/clock.js";
import { SystemClock } from "../adapters/clock/system-clock.js";
import { generateApiKey, hashApiKeySecret } from "../domain/api-key.js";
import { apiKeyRepo } from "../db/repositories/api-key-repo.js";

export interface CreateApiKeyOptions {
  name: string;
  scopes: string[];
  expiresAt?: Date;
}

export interface CreateApiKeyResult {
  plaintext: string;
  keyId: string;
}

/**
 * Creates a new API key (spec §11). This is the ONLY way a key is ever
 * created — there is no HTTP endpoint for it, so a compromised running
 * app can never mint its own credentials. The plaintext is returned once
 * and must never be logged or stored; only its hash goes to the database.
 */
export async function createApiKeyCli(
  db: Kysely<DB>,
  opts: CreateApiKeyOptions,
  clock: Clock = new SystemClock()
): Promise<CreateApiKeyResult> {
  const { plaintext, keyId, secret } = generateApiKey();
  await apiKeyRepo.create(db, {
    keyId,
    hash: hashApiKeySecret(secret),
    name: opts.name,
    scopes: opts.scopes,
    expiresAt: opts.expiresAt ?? null,
  });
  void clock;
  return { plaintext, keyId };
}

/** Revokes a key by its keyId (visible in api_keys, never the secret). */
export async function revokeApiKeyCli(db: Kysely<DB>, keyId: string, clock: Clock = new SystemClock()): Promise<void> {
  await apiKeyRepo.revoke(db, keyId, clock.now());
}
