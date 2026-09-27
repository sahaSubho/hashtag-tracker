import type { RequestHandler } from "express";
import type { RateLimitStore } from "../ports/rate-limit-store.js";

export interface RateLimitConfig {
  store: RateLimitStore;
  limit: number;
  windowMs: number;
  burst: number;
}

/**
 * Per-IP token bucket middleware (spec §9). Uses `req.ip`, which respects
 * Express's `trust proxy` setting — with it left off (the default, spec
 * §13.3), `req.ip` is always the direct socket address, so cycling
 * X-Forwarded-For cannot be used to get a fresh bucket.
 */
export function rateLimitMiddleware(config: RateLimitConfig): RequestHandler {
  return async (req, res, next) => {
    const key = `ip:${req.ip}`;
    const result = await config.store.consume({
      key,
      limit: config.limit,
      windowMs: config.windowMs,
      burst: config.burst,
    });

    res.set("RateLimit-Limit", String(config.limit));
    res.set("RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      res.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({
        error: { code: "rate_limited", message: "too many requests", requestId: req.id },
      });
      return;
    }

    next();
  };
}
