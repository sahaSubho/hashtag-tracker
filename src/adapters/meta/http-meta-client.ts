import { createHmac } from "node:crypto";
import type { MetaClient, MetaPage, MetaTokenHealth } from "../../ports/meta-client.js";
import type { HttpDownloader } from "../../ports/http-downloader.js";
import { sanitizeUrl } from "../../http/logger.js";

export interface HttpMetaClientOptions {
  http: HttpDownloader;
  accessToken: string;
  appSecret: string | undefined;
  igUserId: string;
  apiVersion: string;
  fields: string;
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

/**
 * Real Meta Graph API client (spec §8). Wraps every network error so the
 * request URL — which carries the access token as a query parameter —
 * never reaches a thrown error's message. Adds appsecret_proof when an
 * app secret is configured (required once "Require App Secret" is turned
 * on in the Meta app, spec §15.2).
 *
 * usagePct is always null in this phase: reading Meta's rate-limit usage
 * headers needs the HttpDownloader port to expose response headers, which
 * Phase 2's throttle work (spec §8, plan P2-01) adds alongside the
 * throttle itself.
 */
export class HttpMetaClient implements MetaClient {
  constructor(private readonly opts: HttpMetaClientOptions) {}

  async searchHashtag(name: string): Promise<string> {
    const url = this.buildUrl("ig_hashtag_search", {
      user_id: this.opts.igUserId,
      q: name,
    });
    const body = await this.fetchJson<MetaHashtagSearchResponse>(url);
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

    const url = this.buildUrl(`${hashtagId}/${endpoint}`, params);
    const body = await this.fetchJson<MetaMediaResponse>(url);

    return {
      items: body.data,
      nextCursor: body.paging?.cursors?.after ?? null,
      // See class doc: usage headers aren't reachable through the current
      // HttpDownloader port. Phase 2 wires this up.
      usagePct: null,
    };
  }

  async debugToken(): Promise<MetaTokenHealth> {
    const url = this.buildUrl("debug_token", { input_token: this.opts.accessToken });
    const body = await this.fetchJson<MetaDebugTokenResponse>(url);
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
    url.searchParams.set("access_token", this.opts.accessToken);
    if (this.opts.appSecret) {
      url.searchParams.set("appsecret_proof", this.appsecretProof());
    }
    return url.toString();
  }

  private appsecretProof(): string {
    return createHmac("sha256", this.opts.appSecret!).update(this.opts.accessToken).digest("hex");
  }

  private async fetchJson<T>(url: string): Promise<T> {
    try {
      const result = await this.opts.http.get(url);
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.body) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const json = JSON.parse(text);
      if (json.error) {
        throw new MetaApiError(json.error.code, json.error.message ?? "Meta API error");
      }
      return json as T;
    } catch (err) {
      if (err instanceof MetaApiError) throw err;
      // Never let the raw url (with its token) reach an error message.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Meta API request failed: ${sanitizeMessage(message, url)}`);
    }
  }
}

/** Typed Meta API error, carrying the numeric error code (spec §8 error taxonomy). */
export class MetaApiError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}

/** Strips a leaked full URL (with its token) out of a lower-level error message. */
function sanitizeMessage(message: string, url: string): string {
  if (message.includes(url)) {
    return message.replace(url, sanitizeUrl(url));
  }
  return message;
}
