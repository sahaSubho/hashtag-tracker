import type { SecretProvider } from "../../ports/secret-provider.js";

/**
 * Local SecretProvider: reads from process env (spec §4.1, §13.1). Only
 * used when SECRETS_SOURCE=env, which config.ts already refuses to allow
 * in production — so this adapter never runs against production secrets.
 */
export class EnvSecretProvider implements SecretProvider {
  async get(name: string): Promise<string | undefined> {
    return process.env[name];
  }
}
