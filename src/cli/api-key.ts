import { makeDb } from "../db/pool.js";
import { loadEnvFile } from "../config/load-env-file.js";
import { createApiKeyCli, revokeApiKeyCli } from "./api-key-cli.js";

/**
 * Usage:
 *   npm run apikey:create -- --name <name> --scopes dashboard:read[,admin] [--expires-days N]
 *   npm run apikey:revoke -- --key-id <keyId>
 */
async function main(): Promise<void> {
  loadEnvFile();
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL must be set");
  const db = makeDb(connectionString);

  try {
    if (command === "create") {
      const name = args["name"];
      const scopes = (args["scopes"] ?? "").split(",").filter(Boolean);
      if (!name || scopes.length === 0) {
        throw new Error("usage: apikey create --name <name> --scopes <scope[,scope...]>");
      }
      const expiresDays = args["expires-days"] ? Number(args["expires-days"]) : undefined;
      const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000) : undefined;

      const result = await createApiKeyCli(db, { name, scopes, expiresAt });
      console.log(`Created key ${result.keyId}. Save this now — it will not be shown again:`);
      console.log(result.plaintext);
    } else if (command === "revoke") {
      const keyId = args["key-id"];
      if (!keyId) throw new Error("usage: apikey revoke --key-id <keyId>");
      await revokeApiKeyCli(db, keyId);
      console.log(`Revoked ${keyId}`);
    } else {
      throw new Error("usage: apikey <create|revoke> ...");
    }
  } finally {
    await db.destroy();
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      out[arg.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
