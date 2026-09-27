import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../../src/domain/cursor.js";

const keys = [
  { kid: "k1", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
  { kid: "k2", key: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=" },
];

describe("cursor", () => {
  it("round-trips a valid cursor", () => {
    const t = new Date("2026-09-27T08:00:00Z");
    const encoded = encodeCursor({ t, id: 42 }, keys);
    const decoded = decodeCursor(encoded, keys);
    expect(decoded).toEqual({ t, id: 42 });
  });

  it("signs with the first configured key", () => {
    const encoded = encodeCursor({ t: new Date(), id: 1 }, keys);
    const json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    expect(json.kid).toBe("k1");
  });

  it("rejects a tampered cursor", () => {
    const encoded = encodeCursor({ t: new Date(), id: 1 }, keys);
    const json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    json.id = 999;
    const tampered = Buffer.from(JSON.stringify(json)).toString("base64url");
    expect(() => decodeCursor(tampered, keys)).toThrow();
  });

  it("rejects a cursor signed with an unknown kid", () => {
    const foreignKeys = [{ kid: "other", key: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=" }];
    const encoded = encodeCursor({ t: new Date(), id: 1 }, foreignKeys);
    expect(() => decodeCursor(encoded, keys)).toThrow();
  });

  it("accepts a cursor signed with a previous key still in the configured list", () => {
    const encoded = encodeCursor({ t: new Date(), id: 5 }, [keys[1]!]); // signed with k2 only
    const decoded = decodeCursor(encoded, keys); // both keys configured
    expect(decoded.id).toBe(5);
  });

  it("rejects malformed base64", () => {
    expect(() => decodeCursor("not-valid-base64!!!", keys)).toThrow();
  });
});
