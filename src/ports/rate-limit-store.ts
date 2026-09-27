export interface ConsumeOptions {
  key: string;
  limit: number;
  windowMs: number;
  /** Extra requests allowed on top of `limit` within the window. */
  burst: number;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimitStore {
  consume(opts: ConsumeOptions): Promise<ConsumeResult>;
}
