import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

// Matches Meta's page/user access token shape (EAA-prefixed) and a generic
// query-string access_token= assignment — either would indicate a real or
// realistic-looking secret got committed.
const TOKEN_PATTERNS = [/EAA[A-Za-z0-9]{20,}/, /access_token=[^&\s"']{10,}/];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    // Never scan our own .env (it's git-ignored, but skip defensively) or
    // binary-ish paths that would just add noise.
    .filter((f) => !f.startsWith("node_modules/") && f !== ".env");
}

describe("no committed secrets", () => {
  it("no git-tracked file contains a Meta access token or access_token= assignment", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      let content: string;
      try {
        content = readFileSync(path.join(ROOT, file), "utf8");
      } catch {
        continue; // binary or unreadable — skip
      }
      for (const pattern of TOKEN_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${file} matches ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it(".env.example contains only placeholder values, never a real-looking token", () => {
    const content = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const pattern of TOKEN_PATTERNS) {
      expect(pattern.test(content)).toBe(false);
    }
  });

  it(".env is git-ignored", () => {
    const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.env$/m);
  });
});
