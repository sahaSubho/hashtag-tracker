import { describe, it, expect } from "vitest";
import { HttpMetaClient } from "../../src/adapters/meta/http-meta-client.js";
import { metaClientContract } from "../contract/meta-client.contract.js";
import type { HttpDownloader } from "../../src/ports/http-downloader.js";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  return {
    status: 200,
    location: null,
    contentType: "application/json",
    body: (async function* () {
      yield encoder.encode(JSON.stringify(body));
    })(),
    _headers: headers,
  };
}

/** A minimal scripted HttpDownloader that also exposes response headers. */
class ScriptedHttpClient implements HttpDownloader {
  public requestedUrls: string[] = [];
  constructor(private readonly responses: Map<string, ReturnType<typeof jsonResponse>>) {}

  async get(url: string) {
    this.requestedUrls.push(url);
    const parsed = new URL(url);
    const key = parsed.origin + parsed.pathname;
    const resp = this.responses.get(key);
    if (!resp) throw new Error(`no scripted response for ${key}`);
    return resp;
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

  it("usagePct is null in Phase 1 — the HttpDownloader port carries no response headers yet", async () => {
    // The Meta throttle that reads X-Business-Use-Case-Usage is a Phase 2
    // task (spec §8, plan P2-01). Reading it needs the HttpDownloader port
    // extended to expose response headers, which P2-01 will add alongside
    // the throttle itself. Until then, MetaPage.usagePct is always null —
    // a valid value per its type — and callers must not assume otherwise.
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
    const page = await client.media("recent", "17843", null);
    expect(page.usagePct).toBeNull();
  });
});
