import { describe, it, expect } from "vitest";
import { sanitizeUrl } from "../../src/http/logger.js";

describe("sanitizeUrl", () => {
  it("removes access_token", () => {
    const out = sanitizeUrl(
      "https://graph.facebook.com/v24.0/x?fields=id&access_token=EAAsecret"
    );
    expect(out).not.toContain("EAAsecret");
    expect(out).toContain("fields=id");
  });

  it("removes CDN signature params", () => {
    const out = sanitizeUrl(
      "https://scontent.cdninstagram.com/v/x.jpg?oh=SIG&oe=DEAD&_nc_ht=host"
    );
    expect(out).not.toContain("SIG");
    expect(out).not.toContain("DEAD");
  });

  it("returns a placeholder for an unparseable url", () => {
    expect(sanitizeUrl("not a url::")).toBe("[unparseable-url]");
  });
});
