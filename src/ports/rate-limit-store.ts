export interface ConsumeOptions {
  key: string;
  limit: number;
  windowMs: number;
  /** Extra requests allowed on top of `limit` within the window. */
  burst: number;
  /** Units consumed by this call (default 1). Used for cost-weighted budgets (spec §10 GraphQL cost limiting). */
  cost?: number;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimitStore {
  consume(opts: ConsumeOptions): Promise<ConsumeResult>;
}
