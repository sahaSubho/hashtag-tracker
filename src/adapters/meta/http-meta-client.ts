import { createHmac } from "node:crypto";
import type { MetaClient, MetaPage, MetaTokenHealth } from "../../ports/meta-client.js";
import type { HttpDownloader } from "../../ports/http-downloader.js";
import type { Metrics } from "../../ports/metrics.js";
import { sanitizeUrl } from "../../http/logger.js";
import { MetaThrottle } from "./meta-throttle.js";
import { SystemClock } from "../clock/system-clock.js";
import type { Clock } from "../../ports/clock.js";

export interface HttpMetaClientOptions {
  http: HttpDownloader;
  accessToken: string;
  appSecret: string | undefined;
  igUserId: string;
  apiVersion: string;
  fields: string;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void> | void;
  /** Records meta.calls_total{endpoint,code} (spec §12.2). Optional so tests need not supply one. */
  metrics?: Metrics;
  /**
   * Called at most once per request when a 190 (invalid token) error is
   * received — the token may have just been rotated in Secrets Manager.
   * Returns the refreshed token to retry with. If retrying with it also
   * fails, the error is thrown for real (spec §8, §15.2). When omitted, a
   * 190 fails immediately with no retry.
   */
  refreshAccessToken?: () => Promise<string>;
}

interface MetaMediaResponse {
  data: unknown[];
  paging?: { cursors?: { after?: string }; next?: string };
}

interface MetaHashtagSearchResponse {
  data: Array<{ id: string }>;
}

interface MetaDebugTokenResponse {
  data: { is_valid: boolean; scopes?: string[]; expires_at?: number };
}

interface MetaErrorBody {
  error: { code: number; message?: string };
}

/** Error taxonomy from spec §8. */
export type MetaErrorCategory = "rate_limit" | "temporary" | "fatal";

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const FATAL_CODES = new Set([190, 100]);
const INVALID_TOKEN_CODE = 190;

function categorize(code: number): MetaErrorCategory {
  if (RATE_LIMIT_CODES.has(code)) return "rate_limit";
  if (FATAL_CODES.has(code)) return "fatal";
  return "temporary";
}

/**
 * Real Meta Graph API client (spec §8). Wraps every network error so the
 * request URL — which carries the access token as a query parameter —
 * never reaches a thrown error's message. Adds appsecret_proof when an
 * app secret is configured (required once "Require App Secret" is turned
 * on in the Meta app, spec §15.2).
 *
 * Every response's usage header is fed to a shared MetaThrottle, which the
 * *next* call waits on: above 80% usage, calls are spaced out; at 100%,
 * every call pauses until the estimated reset time. The throttle is
 * per-instance (one HttpMetaClient = one Instagram account's usage
 * budget), matching spec §8's "one throttle per account" model.
 */
export class HttpMetaClient implements MetaClient {
  private readonly throttle: MetaThrottle;
  private accessToken: string;

  constructor(private readonly opts: HttpMetaClientOptions) {
    this.throttle = new MetaThrottle(opts.clock ?? new SystemClock(), { sleep: opts.sleep });
    this.accessToken = opts.accessToken;
  }

  async searchHashtag(name: string): Promise<string> {
    const body = await this.fetchJson<MetaHashtagSearchResponse>("ig_hashtag_search", {
      user_id: this.opts.igUserId,
      q: name,
    });
    const id = body.data[0]?.id;
    if (!id) {
      throw new Error("Meta ig_hashtag_search returned no results");
    }
    return id;
  }

  async media(edge: "top" | "recent", hashtagId: string, cursor: string | null): Promise<MetaPage> {
    const endpoint = edge === "top" ? "top_media" : "recent_media";
    const params: Record<string, string> = {
      user_id: this.opts.igUserId,
      fields: this.opts.fields,
      limit: "25",
    };
    if (cursor) params.after = cursor;

    const body = await this.fetchJson<MetaMediaResponse>(`${hashtagId}/${endpoint}`, params);

    return {
      items: body.data,
      nextCursor: body.paging?.cursors?.after ?? null,
      usagePct: this.throttle.currentUsagePct(),
    };
  }

  async debugToken(): Promise<MetaTokenHealth> {
    const body = await this.fetchJson<MetaDebugTokenResponse>("debug_token", {
      input_token: this.accessToken,
    });
    return {
      valid: body.data.is_valid,
      scopes: body.data.scopes ?? [],
      expiresAt: body.data.expires_at ? new Date(body.data.expires_at * 1000) : null,
    };
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`https://graph.facebook.com/${this.opts.apiVersion}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("access_token", this.accessToken);
    if (this.opts.appSecret) {
      url.searchParams.set("appsecret_proof", this.appsecretProof());
    }
    return url.toString();
  }

  private appsecretProof(): string {
    return createHmac("sha256", this.opts.appSecret!).update(this.accessToken).digest("hex");
  }

  private async fetchJson<T>(
    path: string,
    params: Record<string, string>,
    isRetryAfterRefresh = false
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    await this.throttle.waitTurn();

    const endpoint = path.split("/").pop() ?? path;

    try {
      const result = await this.opts.http.get(url);
      this.throttle.recordUsage(result.headers);

      const chunks: Uint8Array[] = [];
      for await (const chunk of result.body) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const json = JSON.parse(text);

      if (isMetaErrorBody(json)) {
        const apiError = new MetaApiError(json.error.code, json.error.message ?? "Meta API error");
        this.opts.metrics?.inc("meta.calls_total", { endpoint, code: String(apiError.code) });

        if (
          apiError.code === INVALID_TOKEN_CODE &&
          !isRetryAfterRefresh &&
          this.opts.refreshAccessToken
        ) {
          // The token may have just been rotated (e.g. in Secrets Manager);
          // fetch it again once before treating this as a real failure.
          this.accessToken = await this.opts.refreshAccessToken();
          return this.fetchJson<T>(path, params, true);
        }

        throw apiError;
      }

      this.opts.metrics?.inc("meta.calls_total", { endpoint, code: String(result.status) });
      return json as T;
    } catch (err) {
      if (err instanceof MetaApiError) throw err;
      // Never let the raw url (with its token) reach an error message.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Meta API request failed: ${sanitizeMessage(message, url)}`);
    }
  }
}

function isMetaErrorBody(json: unknown): json is MetaErrorBody {
  return (
    typeof json === "object" &&
    json !== null &&
    "error" in json &&
    typeof (json as MetaErrorBody).error === "object"
  );
}

/**
 * Typed Meta API error, carrying the numeric error code and its taxonomy
 * category (spec §8): `rate_limit` (save cursor, re-enqueue with delay),
 * `fatal` (fail immediately, no retry — e.g. an invalid token), or
 * `temporary` (exponential backoff, capped attempts).
 */
export class MetaApiError extends Error {
  public category: MetaErrorCategory;

  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.category = categorize(code);
  }
}

/** Strips a leaked full URL (with its token) out of a lower-level error message. */
function sanitizeMessage(message: string, url: string): string {
  if (message.includes(url)) {
    return message.replace(url, sanitizeUrl(url));
  }
  return message;
}
