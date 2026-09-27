import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKeySecret, parseApiKey } from "../../src/domain/api-key.js";

describe("api key format", () => {
  it("generates a key in the dash_<keyId>_<secret> shape", () => {
    const { plaintext, keyId } = generateApiKey();
    expect(plaintext).toMatch(/^dash_[A-Za-z2-7]{12,}_[A-Za-z0-9_-]{20,}$/);
    expect(plaintext).toContain(keyId);
  });

  it("generates a different secret each time", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyId).not.toBe(b.keyId);
  });

  it("parses a well-formed key into keyId and secret", () => {
    const { plaintext, keyId, secret } = generateApiKey();
    const parsed = parseApiKey(plaintext);
    expect(parsed).toEqual({ keyId, secret });
  });

  it("rejects a malformed key", () => {
    expect(parseApiKey("not-a-real-key")).toBeNull();
    expect(parseApiKey("dash_onlyonepart")).toBeNull();
    expect(parseApiKey("")).toBeNull();
  });

  it("hashes the secret deterministically", () => {
    const { secret } = generateApiKey();
    expect(hashApiKeySecret(secret)).toBe(hashApiKeySecret(secret));
  });

  it("never stores the plaintext secret in the hash", () => {
    const { secret } = generateApiKey();
    expect(hashApiKeySecret(secret)).not.toContain(secret);
  });
});
