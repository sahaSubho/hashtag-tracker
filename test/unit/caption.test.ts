import { describe, it, expect } from "vitest";
import { normalizeCaption, captionNormHash, stripControlChars } from "../../src/domain/caption.js";

describe("caption", () => {
  it("strips NUL bytes", () => {
    expect(stripControlChars("a\u0000b")).toBe("ab");
  });
  it("keeps newlines and tabs", () => {
    expect(stripControlChars("a\nb\tc")).toBe("a\nb\tc");
  });
  it("normalizes case and whitespace", () => {
    expect(normalizeCaption("  Matcha   Latte​ ")).toBe("matcha latte");
  });
  it("returns null hash for short captions", () => {
    expect(captionNormHash("matcha 🍵")).toBeNull();
  });
  it("returns a stable hash for long captions", () => {
    const long = "the best matcha latte recipe you will ever make at home, guaranteed";
    expect(captionNormHash(long)).toMatch(/^[0-9a-f]{64}$/);
    expect(captionNormHash(long)).toBe(captionNormHash(long.toUpperCase()));
  });
  it("returns null for a null caption", () => {
    expect(captionNormHash(null)).toBeNull();
  });
});
