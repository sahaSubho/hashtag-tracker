import { describe, it, expect } from "vitest";

describe("scaffold", () => {
  it("exposes the app version from package.json", async () => {
    const pkg = (await import("../../package.json", { with: { type: "json" } })).default;
    expect(pkg.name).toBe("hashtag-tracker");
    expect(pkg.type).toBe("module");
  });
});
