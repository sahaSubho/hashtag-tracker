import { createHmac, timingSafeEqual } from "node:crypto";

export interface CursorSigningKey {
  kid: string;
  key: string;
}

export interface FeedCursor {
  t: Date;
  id: number;
}

interface CursorPayload {
  t: string;
  id: number;
  kid: string;
  sig: string;
}

function sign(kid: string, t: string, id: number, keys: CursorSigningKey[]): string {
  const key = keys.find((k) => k.kid === kid);
  if (!key) throw new Error(`cursor: unknown signing key ${kid}`);
  return createHmac("sha256", key.key).update(`${t}.${id}.${kid}`).digest("base64url");
}

/**
 * Encodes a keyset-pagination cursor as base64url JSON, HMAC-signed with
 * the first configured key (spec §9). The signature covers the timestamp,
 * id and key id, so a tampered field is detected on decode.
 */
export function encodeCursor(cursor: FeedCursor, keys: CursorSigningKey[]): string {
  if (keys.length === 0) throw new Error("cursor: no signing keys configured");
  const kid = keys[0]!.kid;
  const t = cursor.t.toISOString();
  const sig = sign(kid, t, cursor.id, keys);
  const payload: CursorPayload = { t, id: cursor.id, kid, sig };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decodes and verifies a cursor. Accepts a cursor signed by *any* key
 * currently in `keys` (not just the first), so a signing-key rotation has
 * an overlap window where both old and new keys are accepted, and a key
 * removed from the list is rejected. Throws on any malformed, tampered, or
 * unknown-key cursor.
 */
export function decodeCursor(encoded: string, keys: CursorSigningKey[]): FeedCursor {
  let payload: CursorPayload;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    throw new Error("cursor: malformed");
  }

  if (
    typeof payload.t !== "string" ||
    typeof payload.id !== "number" ||
    typeof payload.kid !== "string" ||
    typeof payload.sig !== "string"
  ) {
    throw new Error("cursor: malformed payload");
  }

  const expectedSig = sign(payload.kid, payload.t, payload.id, keys);
  const a = Buffer.from(payload.sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("cursor: invalid signature");
  }

  const t = new Date(payload.t);
  if (Number.isNaN(t.getTime())) {
    throw new Error("cursor: invalid timestamp");
  }

  return { t, id: payload.id };
}
