import { randomBytes, createHash } from "node:crypto";

const KEY_ID_BYTES = 8; // base32-encoded, ~13 chars
const SECRET_BYTES = 32;
const PREFIX = "dash";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export interface GeneratedApiKey {
  /** The full key, shown to the user exactly once. Never stored. */
  plaintext: string;
  keyId: string;
  secret: string;
}

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

/**
 * Generates a new API key in the `dash_<keyId>_<secret>` form (spec §11).
 * keyId is public (used as the lookup key in api_keys) and does not need
 * to be secret; the secret has 256 bits of randomness, so a slow
 * password hash isn't needed for the stored hash.
 */
export function generateApiKey(): GeneratedApiKey {
  const keyId = toBase32(randomBytes(KEY_ID_BYTES));
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { plaintext: `${PREFIX}_${keyId}_${secret}`, keyId, secret };
}

/**
 * Parses a `dash_<keyId>_<secret>` string. Returns null if it's malformed.
 * Splits only on the first two underscores — the secret itself is
 * base64url and can legitimately contain `_`, so a naive split("_") would
 * wrongly reject most real keys.
 */
export function parseApiKey(plaintext: string): ParsedApiKey | null {
  const firstUnderscore = plaintext.indexOf("_");
  if (firstUnderscore < 0) return null;
  const prefix = plaintext.slice(0, firstUnderscore);
  if (prefix !== PREFIX) return null;

  const rest = plaintext.slice(firstUnderscore + 1);
  const secondUnderscore = rest.indexOf("_");
  if (secondUnderscore < 0) return null;

  const keyId = rest.slice(0, secondUnderscore);
  const secret = rest.slice(secondUnderscore + 1);
  if (!keyId || !secret || keyId.length < 8 || secret.length < 20) return null;
  return { keyId, secret };
}

/** SHA-256 hash of a key's secret, hex-encoded — what's actually stored in api_keys.hash. */
export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
