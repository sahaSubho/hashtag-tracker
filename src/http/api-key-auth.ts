import { timingSafeEqual, createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import type { Clock } from "../ports/clock.js";
import { apiKeyRepo } from "../db/repositories/api-key-repo.js";
import { parseApiKey, hashApiKeySecret } from "../domain/api-key.js";

export interface AuthResult {
  ok: boolean;
  reason?: "malformed" | "not_found" | "wrong_secret" | "revoked" | "expired" | "missing_scope";
  keyId?: string;
}

// A fixed, never-real dummy hash so that looking up an unknown keyId still
// runs a comparison of the same shape and cost as a real one (spec §11).
const DUMMY_HASH = createHash("sha256").update("dummy").digest("hex");

const LAST_USED_THROTTLE_MS = 60 * 1000;

/**
 * Verifies an API key against the api_keys table (spec §11): checks the
 * secret with a constant-time comparison, then expiry, revocation, and
 * scope. An unknown keyId still hashes and compares against a dummy value
 * before returning, so a wrong-secret failure and an unknown-keyId failure
 * take the same time — timing alone can't be used to enumerate valid
 * keyIds.
 */
export async function authenticateApiKey(
  db: Kysely<DB>,
  clock: Clock,
  plaintext: string,
  requiredScope: string
): Promise<AuthResult> {
  const parsed = parseApiKey(plaintext);
  if (!parsed) return { ok: false, reason: "malformed" };

  const row = await apiKeyRepo.findByKeyId(db, parsed.keyId);
  const expectedHash = row?.hash ?? DUMMY_HASH;
  const suppliedHash = hashApiKeySecret(parsed.secret);

  const matches = safeEqual(suppliedHash, expectedHash);
  if (!row || !matches) {
    return { ok: false, reason: row ? "wrong_secret" : "not_found" };
  }

  if (row.revoked_at !== null) {
    return { ok: false, reason: "revoked", keyId: row.key_id };
  }
  if (row.expires_at !== null && row.expires_at.getTime() <= clock.now().getTime()) {
    return { ok: false, reason: "expired", keyId: row.key_id };
  }
  if (!row.scopes.includes(requiredScope)) {
    return { ok: false, reason: "missing_scope", keyId: row.key_id };
  }

  const now = clock.now();
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() >= LAST_USED_THROTTLE_MS) {
    await apiKeyRepo.touchLastUsed(db, row.key_id, now);
  }

  return { ok: true, keyId: row.key_id };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
