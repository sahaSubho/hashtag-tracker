import { describe, it, expect } from "vitest";
import { HttpMetaClient } from "../../src/adapters/meta/http-meta-client.js";
import { metaClientContract } from "../contract/meta-client.contract.js";
import type { HttpDownloader } from "../../src/ports/http-downloader.js";

// A body's async-generator can only be iterated once, but tests may call
// the client multiple times against the same scripted URL (e.g. to observe
// throttle behavior across calls) — so responses are built fresh per get()
// via a factory, not stored pre-built.
function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  return () => ({
    status: 200,
    location: null,
    contentType: "application/json",
    body: (async function* () {
      yield encoder.encode(JSON.stringify(body));
    })(),
    headers,
  });
}

/** A minimal scripted HttpDownloader that also exposes response headers. */
class ScriptedHttpClient implements HttpDownloader {
  public requestedUrls: string[] = [];
  constructor(private readonly responses: Map<string, ReturnType<typeof jsonResponse>>) {}

  async get(url: string) {
    this.requestedUrls.push(url);
    const parsed = new URL(url);
    const key = parsed.origin + parsed.pathname;
    const factory = this.responses.get(key);
    if (!factory) throw new Error(`no scripted response for ${key}`);
    return factory();
  }
}

const FIELDS =
  "id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count,children{media_type,media_url}";

metaClientContract(() => {
  const responses = new Map<string, ReturnType<typeof jsonResponse>>();
  responses.set("https://graph.facebook.com/v24.0/17843/recent_media", jsonResponse({ data: [] }));
  responses.set("https://graph.facebook.com/v24.0/debug_token", jsonResponse({ data: { is_valid: true, scopes: [], expires_at: 0 } }));
  const http = new ScriptedHttpClient(responses);
  return new HttpMetaClient({
    http,
    accessToken: "test-token",
    appSecret: undefined,
    igUserId: "123",
    apiVersion: "v24.0",
    fields: FIELDS,
  });
});

describe("HttpMetaClient", () => {
  it("never lets the access_token reach a thrown error message", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    // No scripted response registered -> ScriptedHttpClient throws with the
    // full URL in its message; HttpMetaClient must still sanitize before
    // it re-throws or wraps.
    const http: HttpDownloader = {
      async get(url: string) {
        throw new Error(`connection failed for ${url}`);
      },
    };
    const client = new HttpMetaClient({
      http,
      accessToken: "SECRET_TOKEN_VALUE",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    await expect(client.media("recent", "17843", null)).rejects.toThrow();
    try {
      await client.media("recent", "17843", null);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("SECRET_TOKEN_VALUE");
    }
    void responses;
  });

  it("includes appsecret_proof when an app secret is configured", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set("https://graph.facebook.com/v24.0/17843/recent_media", jsonResponse({ data: [] }));
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: "shh",
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    await client.media("recent", "17843", null);
    expect(http.requestedUrls[0]).toContain("appsecret_proof=");
  });

  it("omits appsecret_proof when no app secret is configured", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set("https://graph.facebook.com/v24.0/17843/recent_media", jsonResponse({ data: [] }));
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    await client.media("recent", "17843", null);
    expect(http.requestedUrls[0]).not.toContain("appsecret_proof");
  });

  it("searchHashtag calls ig_hashtag_search with the hashtag name", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set(
      "https://graph.facebook.com/v24.0/ig_hashtag_search",
      jsonResponse({ data: [{ id: "17843" }] })
    );
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    const id = await client.searchHashtag("matcha");
    expect(id).toBe("17843");
    expect(http.requestedUrls[0]).toContain("q=matcha");
  });

  it("passes through the nextCursor from the paging.cursors.after field", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse({ data: [{ id: "1" }], paging: { cursors: { after: "abc" }, next: "https://x" } })
    );
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    const page = await client.media("recent", "17843", null);
    expect(page.nextCursor).toBe("abc");
  });

  it("usagePct reflects the X-Business-Use-Case-Usage header from the response", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse(
        { data: [] },
        { "x-business-use-case-usage": JSON.stringify({ "123": [{ call_count: 42 }] }) }
      )
    );
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });
    const page = await client.media("recent", "17843", null);
    expect(page.usagePct).toBe(42);
  });

  it("spaces out the next call once usage is at or above 80%", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse(
        { data: [] },
        { "x-business-use-case-usage": JSON.stringify({ "123": [{ call_count: 85 }] }) }
      )
    );
    const http = new ScriptedHttpClient(responses);
    const sleeps: number[] = [];
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
      sleep: (ms) => {
        sleeps.push(ms);
      },
    });

    await client.media("recent", "17843", null); // records 85% usage
    await client.media("recent", "17843", null); // should be spaced out this time
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("pauses until the reset time once usage hits 100%", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse(
        { data: [] },
        {
          "x-business-use-case-usage": JSON.stringify({
            "123": [{ call_count: 100, estimated_time_to_regain_access: 5 }],
          }),
        }
      )
    );
    const http = new ScriptedHttpClient(responses);
    const sleeps: number[] = [];
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
      sleep: (ms) => {
        sleeps.push(ms);
      },
    });

    await client.media("recent", "17843", null); // records 100% usage, 5 min reset
    await client.media("recent", "17843", null); // pauses 5 minutes before this call
    expect(sleeps).toContain(5 * 60 * 1000);
  });

  it("classifies a rate-limit error code as retryable (retryable=true)", async () => {
    const responses = new Map<string, any>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse({ error: { code: 4, message: "rate limited" } })
    );
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    try {
      await client.media("recent", "17843", null);
      expect.unreachable();
    } catch (err: any) {
      expect(err.code).toBe(4);
      expect(err.category).toBe("rate_limit");
    }
  });

  it("classifies a token error (190) as fatal (category=fatal)", async () => {
    const responses = new Map<string, any>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse({ error: { code: 190, message: "invalid token" } })
    );
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    try {
      await client.media("recent", "17843", null);
      expect.unreachable();
    } catch (err: any) {
      expect(err.code).toBe(190);
      expect(err.category).toBe("fatal");
    }
  });

  it("classifies an unknown error code as temporary by default", async () => {
    const responses = new Map<string, any>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse({ error: { code: 2, message: "server error" } })
    );
    const http = new ScriptedHttpClient(responses);
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
    });

    try {
      await client.media("recent", "17843", null);
      expect.unreachable();
    } catch (err: any) {
      expect(err.category).toBe("temporary");
    }
  });
});
