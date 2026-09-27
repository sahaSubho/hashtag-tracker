import { describe, it, expect } from "vitest";
import { parseUrlExpiry } from "../../src/domain/url-expiry.js";

describe("parseUrlExpiry", () => {
  it("parses the hex oe param", () => {
    const epoch = Math.floor(Date.now() / 1000) + 3600;
    const hex = epoch.toString(16);
    const d = parseUrlExpiry(`https://x.fbcdn.net/a.jpg?oe=${hex}`);
    expect(d?.getTime()).toBe(epoch * 1000);
  });

  it("parses the decimal _nc_exp param", () => {
    const epoch = Math.floor(Date.now() / 1000) + 7200;
    const d = parseUrlExpiry(`https://x.fbcdn.net/a.jpg?_nc_exp=${epoch}`);
    expect(d?.getTime()).toBe(epoch * 1000);
  });

  it("returns null when absent", () => {
    expect(parseUrlExpiry("https://x.fbcdn.net/a.jpg")).toBeNull();
  });

  it("returns null for an unparseable url", () => {
    expect(parseUrlExpiry("not a url::")).toBeNull();
  });

  it("returns null for an absurd value far in the past", () => {
    const longAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 400;
    expect(parseUrlExpiry(`https://x.fbcdn.net/a.jpg?oe=${longAgo.toString(16)}`)).toBeNull();
  });
});
