import { describe, it, expect } from "vitest";
import { HttpMetaClient, MetaApiError } from "../../src/adapters/meta/http-meta-client.js";
import type { HttpDownloader } from "../../src/ports/http-downloader.js";

function jsonResponse(body: unknown) {
  const encoder = new TextEncoder();
  return () => ({
    status: 200,
    location: null,
    contentType: "application/json",
    body: (async function* () {
      yield encoder.encode(JSON.stringify(body));
    })(),
    headers: {},
  });
}

describe("HttpMetaClient — token refresh on 190 (spec §8, §15.2)", () => {
  it("on a 190 error, fetches the secret again once and retries with the new token", async () => {
    const calls: string[] = [];
    const http: HttpDownloader = {
      async get(url: string) {
        calls.push(url);
        if (url.includes("access_token=old-token")) {
          return jsonResponse({ error: { code: 190, message: "invalid token" } })();
        }
        return jsonResponse({ data: [] })();
      },
    };

    let currentToken = "old-token";
    const client = new HttpMetaClient({
      http,
      accessToken: currentToken,
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: "id",
      refreshAccessToken: async () => {
        currentToken = "new-token";
        return currentToken;
      },
    });

    const page = await client.media("recent", "17843", null);
    expect(page.items).toEqual([]);
    expect(calls.some((u) => u.includes("access_token=new-token"))).toBe(true);
  });

  it("fails loudly if the refreshed token also gets a 190", async () => {
    const http: HttpDownloader = {
      async get() {
        return jsonResponse({ error: { code: 190, message: "invalid token" } })();
      },
    };

    const client = new HttpMetaClient({
      http,
      accessToken: "old-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: "id",
      refreshAccessToken: async () => "still-bad-token",
    });

    await expect(client.media("recent", "17843", null)).rejects.toMatchObject({
      category: "fatal",
    });
  });

  it("without a refreshAccessToken configured, a 190 fails immediately with no retry", async () => {
    let calls = 0;
    const http: HttpDownloader = {
      async get() {
        calls++;
        return jsonResponse({ error: { code: 190, message: "invalid token" } })();
      },
    };

    const client = new HttpMetaClient({
      http,
      accessToken: "old-token",
      appSecret: undefined,
      igUserId: "123",
      apiVersion: "v24.0",
      fields: "id",
    });

    await expect(client.media("recent", "17843", null)).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toBe(1);
  });
});
