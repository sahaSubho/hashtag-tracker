import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/env.js";

const base = {
  DATABASE_URL: "postgres://app@localhost/db",
  META_IG_USER_ID: "123",
};

describe("loadConfig", () => {
  it("applies defaults from spec §17", () => {
    const c = loadConfig(base);
    expect(c.hashtag).toBe("matcha");
    expect(c.syncMaxItems).toBe(500);
    expect(c.downloadConcurrency).toBe(5);
    expect(c.maxAssetBytes).toBe(104857600);
    expect(c.mediaHostAllowlist).toEqual(["*.cdninstagram.com", "*.fbcdn.net"]);
  });

  it("parses CURSOR_SIGNING_KEYS into kid/key pairs", () => {
    const c = loadConfig({ ...base, CURSOR_SIGNING_KEYS: "k1:AAA,k2:BBB" });
    expect(c.cursorSigningKeys).toEqual([
      { kid: "k1", key: "AAA" },
      { kid: "k2", key: "BBB" },
    ]);
  });

  it("throws when a required var is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("in production rejects SECRETS_SOURCE=env", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", SECRETS_SOURCE: "env" })
    ).toThrow(/production/i);
  });
});
