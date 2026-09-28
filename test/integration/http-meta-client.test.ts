import { describe, it, expect } from "vitest";
import { HttpMetaClient, META_MEDIA_FIELDS } from "../../src/adapters/meta/http-meta-client.js";
import { metaClientContract } from "../contract/meta-client.contract.js";
import type { HttpDownloader } from "../../src/ports/http-downloader.js";
import { FakeClock } from "../helpers/fakes.js";

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
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
      clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
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

  it("records meta.calls_total per endpoint and response code", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set("https://graph.facebook.com/v24.0/17843/recent_media", jsonResponse({ data: [] }));
    const http = new ScriptedHttpClient(responses);
    const calls: Array<{ name: string; labels?: Record<string, string> }> = [];
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
      metrics: {
        inc: (name, labels) => calls.push({ name, labels }),
        gauge: () => {},
        observe: () => {},
      },
    });

    await client.media("recent", "17843", null);

    const call = calls.find((c) => c.name === "meta.calls_total");
    expect(call?.labels).toMatchObject({ endpoint: "recent_media", code: "200" });
  });

  it("records meta.calls_total with the error code on a Meta API error", async () => {
    const responses = new Map<string, ReturnType<typeof jsonResponse>>();
    responses.set(
      "https://graph.facebook.com/v24.0/17843/recent_media",
      jsonResponse({ error: { code: 4, message: "rate limited" } })
    );
    const http = new ScriptedHttpClient(responses);
    const calls: Array<{ name: string; labels?: Record<string, string> }> = [];
    const client = new HttpMetaClient({
      http,
      accessToken: "test-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: FIELDS,
      metrics: {
        inc: (name, labels) => calls.push({ name, labels }),
        gauge: () => {},
        observe: () => {},
      },
    });

    await client.media("recent", "17843", null).catch(() => {});

    const call = calls.find((c) => c.name === "meta.calls_total");
    expect(call?.labels).toMatchObject({ endpoint: "recent_media", code: "4" });
  });

  it("does not request carousel children on hashtag edges (Meta rejects it)", () => {
    // Found against the live API (2026-09-28): with children{...} in the
    // field list, top_media fails with code 1 "Please reduce the amount of
    // data you're asking for" at every page size down to 5.
    expect(META_MEDIA_FIELDS).not.toContain("children");
    expect(META_MEDIA_FIELDS.split(",")).toEqual(
      expect.arrayContaining(["id", "media_type", "timestamp", "permalink", "media_url"])
    );
  });

  describe("page-size shrinking on Meta's 'reduce the amount of data' error", () => {
    const TOO_MUCH = { error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" } };

    /** Answers based on the request's `limit` query param. */
    function limitAwareClient(respond: (limit: number) => unknown) {
      const limits: number[] = [];
      const http: HttpDownloader = {
        async get(url: string) {
          const limit = Number(new URL(url).searchParams.get("limit"));
          limits.push(limit);
          return jsonResponse(respond(limit))();
        },
      };
      const client = new HttpMetaClient({
        http,
        accessToken: "test-token",
        appSecret: undefined,
        igUserId: "123",
        apiVersion: "v24.0",
        fields: META_MEDIA_FIELDS,
      });
      return { client, limits };
    }

    it("retries the same page with a smaller limit and returns its items", async () => {
      const { client, limits } = limitAwareClient((limit) =>
        limit > 10 ? TOO_MUCH : { data: [{ id: "m1" }], paging: { cursors: { after: "c2" } } }
      );

      const page = await client.media("top", "17843", "c1");

      expect(limits).toEqual([25, 10]);
      expect(page.items).toEqual([{ id: "m1" }]);
      expect(page.nextCursor).toBe("c2");
    });

    it("gives up with the original temporary error once the smallest limit also fails", async () => {
      const { client, limits } = limitAwareClient(() => TOO_MUCH);

      await expect(client.media("top", "17843", null)).rejects.toMatchObject({ code: 1, category: "temporary" });
      expect(limits).toEqual([25, 10, 5]);
    });

    it("does not shrink for other code-1 errors (e.g. a genuinely unknown error)", async () => {
      const { client, limits } = limitAwareClient(() => ({ error: { code: 1, message: "An unknown error occurred" } }));

      await expect(client.media("top", "17843", null)).rejects.toMatchObject({ code: 1 });
      expect(limits).toEqual([25]);
    });
  });
});
