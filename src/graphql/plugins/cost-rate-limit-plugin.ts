import { GraphQLError } from "graphql";
import { costLimitRule, type CostLimitOptions } from "@escape.tech/graphql-armor-cost-limit";
import type { Plugin } from "graphql-yoga";
import type { RateLimitStore } from "../../ports/rate-limit-store.js";

const WINDOW_MS = 60_000;

interface CostRateLimitContext {
  apiKeyId?: string;
  __graphqlCost?: number;
}

/**
 * Charges each query's cost (armor's own complexity calculation — object
 * cost + scalar cost + depth factor, spec §10) against a per-API-key
 * budget (GRAPHQL_COST_PER_MIN, default 10000). Reuses the exact
 * RateLimitStore/InMemoryRateLimitStore built for REST rate limiting
 * (P2-02) with a `dashboard:<apiKeyId>` bucket key instead of REST's IP
 * key, rather than inventing a second mechanism.
 *
 * Runs armor's `costLimitRule` itself (the same validation rule the
 * separate costLimit protection plugin also runs, so a query already over
 * `maxCost` is rejected by that plugin first) inside its own onValidate
 * hook, and writes the computed cost onto the shared per-request context
 * via `extendContext` — the supported Envelop mechanism for passing data
 * from onValidate to onExecute for the same request, since armor's own
 * ValidationContext is not the same object as this app's contextValue and
 * can't otherwise be correlated across those two hooks.
 */
export function costRateLimitPlugin(
  store: RateLimitStore,
  costPerMin: number
): Plugin<CostRateLimitContext> {
  const options: CostLimitOptions = { exposeLimits: false, propagateOnRejection: false };

  return {
    onValidate({ addValidationRule, extendContext }) {
      addValidationRule(
        costLimitRule({
          ...options,
          onAccept: [(_ctx, details) => extendContext({ __graphqlCost: details.n })],
          // A rejection here means armor's separate maxCost protection will
          // also reject it (or already did, if that plugin runs first); this
          // rule's own rejection is silenced (propagateOnRejection: false)
          // so it never double-reports the same error — cost tracking is
          // this plugin's only job, not enforcing the cost ceiling.
        })
      );
    },

    async onExecute({ args, setResultAndStopExecution }) {
      const apiKeyId = args.contextValue.apiKeyId;
      const cost = args.contextValue.__graphqlCost ?? 1;
      const key = `dashboard:${apiKeyId ?? "anonymous"}`;

      const result = await store.consume({ key, limit: costPerMin, windowMs: WINDOW_MS, burst: 0, cost });
      if (!result.allowed) {
        setResultAndStopExecution({
          errors: [
            new GraphQLError("GraphQL cost budget exceeded for this API key", {
              extensions: { code: "RATE_LIMITED", retryAfterMs: result.retryAfterMs },
            }),
          ],
        });
      }
    },
  };
}
