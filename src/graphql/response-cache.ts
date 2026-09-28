import { createHash } from "node:crypto";
import { print, type ExecutionResult } from "graphql";
import type { Plugin } from "graphql-yoga";

const TTL_MS = 30_000;

interface CacheEntry {
  result: ExecutionResult;
  expiresAt: number;
}

/**
 * A small in-memory response cache (spec §10), keyed by operation body +
 * variables + api key, TTL 30s. Cleared whenever a sync run finishes
 * (wired by the caller through `clear()`), since that's the only thing
 * that changes the underlying data on a schedule this predictable — no
 * dependency on a real cache server is needed at this scale, and a Map is
 * sufficient (unbounded growth isn't a real risk: entries expire in 30s
 * and the key space is bounded by the dashboard's own small set of
 * queries × api keys in use).
 */
export class ResponseCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  key(query: string, variables: unknown, apiKeyId: string | undefined): string {
    return createHash("sha256")
      .update(query)
      .update(JSON.stringify(variables ?? {}))
      .update(apiKeyId ?? "")
      .digest("hex");
  }

  get(key: string): ExecutionResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(key: string, result: ExecutionResult): void {
    this.entries.set(key, { result, expiresAt: this.now() + TTL_MS });
  }

  clear(): void {
    this.entries.clear();
  }
}

export function responseCachePlugin(cache: ResponseCache): Plugin<{ apiKeyId?: string }> {
  return {
    onExecute({ args, setResultAndStopExecution }) {
      const key = cache.key(print(args.document), args.variableValues, args.contextValue.apiKeyId);
      const cached = cache.get(key);
      if (cached) {
        setResultAndStopExecution(cached);
        return;
      }
      return {
        onExecuteDone: ({ result }) => {
          // Subscriptions/streamed results aren't cached — only a plain
          // single ExecutionResult, which is all this schema produces.
          if (!("next" in result) && !("return" in result)) {
            cache.set(key, result as ExecutionResult);
          }
        },
      };
    },
  };
}
