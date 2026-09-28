import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../../src/config/load-env-file.js";

describe("loadEnvFile", () => {
  const dirs: string[] = [];
  const touched: string[] = [];

  function tempEnvFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "env-file-"));
    dirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, contents);
    return path;
  }

  afterEach(() => {
    for (const key of touched.splice(0)) delete process.env[key];
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads variables from the file into process.env", () => {
    touched.push("LOAD_ENV_TEST_A", "LOAD_ENV_TEST_CRON");
    const path = tempEnvFile("LOAD_ENV_TEST_A=from-file\nLOAD_ENV_TEST_CRON=0 */3 * * *\n");

    expect(loadEnvFile(path)).toBe(true);
    expect(process.env.LOAD_ENV_TEST_A).toBe("from-file");
    expect(process.env.LOAD_ENV_TEST_CRON).toBe("0 */3 * * *");
  });

  it("never overrides a variable already set in the real environment", () => {
    touched.push("LOAD_ENV_TEST_B");
    process.env.LOAD_ENV_TEST_B = "from-shell";
    const path = tempEnvFile("LOAD_ENV_TEST_B=from-file\n");

    loadEnvFile(path);
    expect(process.env.LOAD_ENV_TEST_B).toBe("from-shell");
  });

  it("is a silent no-op when the file does not exist (production has no .env)", () => {
    expect(loadEnvFile(join(tmpdir(), "definitely-missing-dir", ".env"))).toBe(false);
  });
});
