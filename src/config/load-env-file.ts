import { existsSync } from "node:fs";

/**
 * Loads a local `.env` file into process.env for local development, using
 * Node's built-in parser (no dotenv dependency). Variables already set in the
 * real environment always win over the file, and a missing file is a silent
 * no-op — production (ECS, spec §15) has no .env and gets its config from the
 * task definition and Secrets Manager instead.
 *
 * Called at the top of each entry point's main(), never at module import time:
 * src/db/migrate.ts is also imported by the test suite, and tests must never
 * pick up a developer's real credentials from .env.
 */
export function loadEnvFile(path = ".env"): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
