import {
  SecretsManagerClient,
  GetSecretValueCommand,
  type SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import type { SecretProvider } from "../../ports/secret-provider.js";
import type { Clock } from "../../ports/clock.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // spec §15.2: fetched at runtime with a 5-min cache

interface CacheEntry {
  value: string | undefined;
  expiresAt: number;
}

export interface SecretsManagerProviderOptions {
  client: SecretsManagerClient | SecretsManagerClientConfig;
  clock: Clock;
  cacheTtlMs?: number;
}

/**
 * Secrets Manager-backed SecretProvider (spec §4.1, §15.2). Caches each
 * secret's value for 5 minutes so rotation takes effect without a
 * redeploy — a stale cached value is only ever wrong for up to 5 minutes,
 * and MetaClient's own "fetch again once on a 190 error" fallback (spec
 * §8) covers the case where a rotation happens to land inside that
 * window right when a call needs the fresh value.
 *
 * `name` here is the secret's ARN or name in Secrets Manager, not
 * necessarily identical to the env var name EnvSecretProvider would use
 * for the same logical secret — callers (index.ts) are responsible for
 * that mapping.
 */
export class SecretsManagerProvider implements SecretProvider {
  private readonly client: SecretsManagerClient;
  private readonly clock: Clock;
  private readonly cacheTtlMs: number;
  private cache = new Map<string, CacheEntry>();

  constructor(opts: SecretsManagerProviderOptions) {
    this.client =
      opts.client instanceof SecretsManagerClient ? opts.client : new SecretsManagerClient(opts.client);
    this.clock = opts.clock;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async get(name: string): Promise<string | undefined> {
    const now = this.clock.now().getTime();
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await this.fetch(name);
    this.cache.set(name, { value, expiresAt: now + this.cacheTtlMs });
    return value;
  }

  /** Bypasses the cache and re-fetches immediately — used by MetaClient's 190-error fallback (spec §8), which needs to know right away whether a rotation just happened. */
  async refresh(name: string): Promise<string | undefined> {
    const value = await this.fetch(name);
    this.cache.set(name, { value, expiresAt: this.clock.now().getTime() + this.cacheTtlMs });
    return value;
  }

  private async fetch(name: string): Promise<string | undefined> {
    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return result.SecretString;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "ResourceNotFoundException";
}
