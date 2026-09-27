import { describe, it, expect } from "vitest";
import { FakeDns, FakeDownloader } from "../helpers/fakes.js";
import { guardedDownload } from "../../src/adapters/downloader/fetch-downloader.js";

const allowlist = ["*.cdninstagram.com", "*.fbcdn.net"];

describe("guardedDownload — SSRF protections", () => {
  it("rejects http:// urls", async () => {
    const dns = new FakeDns({});
    const inner = new FakeDownloader({});
    await expect(
      guardedDownload(
        { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
        "http://x.cdninstagram.com/a.jpg"
      )
    ).rejects.toThrow(/https/i);
    expect(inner.requestedUrls).toEqual([]);
  });

  it("rejects a host outside the allowlist", async () => {
    const dns = new FakeDns({ "evil.example.com": ["93.184.216.34"] });
    const inner = new FakeDownloader({});
    await expect(
      guardedDownload(
        { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
        "https://evil.example.com/a.jpg"
      )
    ).rejects.toThrow(/allowlist/i);
    expect(inner.requestedUrls).toEqual([]);
  });

  it("rejects an allowed hostname that resolves to a private IP", async () => {
    const dns = new FakeDns({ "x.cdninstagram.com": ["10.0.0.5"] });
    const inner = new FakeDownloader({});
    await expect(
      guardedDownload(
        { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
        "https://x.cdninstagram.com/a.jpg"
      )
    ).rejects.toThrow(/private|not allowed/i);
    expect(inner.requestedUrls).toEqual([]);
  });

  it("rejects the ECS task metadata address even on an allowed host", async () => {
    const dns = new FakeDns({ "x.cdninstagram.com": ["169.254.170.2"] });
    const inner = new FakeDownloader({});
    await expect(
      guardedDownload(
        { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
        "https://x.cdninstagram.com/a.jpg"
      )
    ).rejects.toThrow();
    expect(inner.requestedUrls).toEqual([]);
  });

  it("allows a public IP behind an allowed host and streams the body", async () => {
    const dns = new FakeDns({ "x.cdninstagram.com": ["157.240.2.35"] });
    const inner = new FakeDownloader({
      "https://x.cdninstagram.com/a.jpg": {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        bodyChunks: [new Uint8Array([1, 2, 3])],
      },
    });
    const result = await guardedDownload(
      { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
      "https://x.cdninstagram.com/a.jpg"
    );
    const chunks: Uint8Array[] = [];
    for await (const c of result.body) chunks.push(c);
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
    expect(result.contentType).toBe("image/jpeg");
  });

  it("rejects a redirect to a private address, re-checked at that hop", async () => {
    const dns = new FakeDns({
      "x.cdninstagram.com": ["157.240.2.35"],
      "internal.example.com": ["10.0.0.9"],
    });
    const inner = new FakeDownloader({
      "https://x.cdninstagram.com/a.jpg": {
        status: 302,
        redirectTo: "https://internal.example.com/secret",
      },
    });
    await expect(
      guardedDownload(
        { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
        "https://x.cdninstagram.com/a.jpg"
      )
    ).rejects.toThrow(/allowlist/i);
    // Only the first hop was ever requested — the guard never fetches the target.
    expect(inner.requestedUrls).toEqual(["https://x.cdninstagram.com/a.jpg"]);
  });

  it("follows a redirect that stays within the allowlist and public IPs", async () => {
    const dns = new FakeDns({
      "x.cdninstagram.com": ["157.240.2.35"],
      "y.fbcdn.net": ["157.240.2.36"],
    });
    const inner = new FakeDownloader({
      "https://x.cdninstagram.com/a.jpg": {
        status: 302,
        redirectTo: "https://y.fbcdn.net/a.jpg",
      },
      "https://y.fbcdn.net/a.jpg": {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        bodyChunks: [new Uint8Array([9])],
      },
    });
    const result = await guardedDownload(
      { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
      "https://x.cdninstagram.com/a.jpg"
    );
    const chunks: Uint8Array[] = [];
    for await (const c of result.body) chunks.push(c);
    expect(chunks).toEqual([new Uint8Array([9])]);
  });

  it("throws HttpStatusError on a non-2xx, non-redirect response", async () => {
    const dns = new FakeDns({ "x.cdninstagram.com": ["157.240.2.35"] });
    const inner = new FakeDownloader({
      "https://x.cdninstagram.com/gone.jpg": { status: 403 },
    });
    await expect(
      guardedDownload(
        { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
        "https://x.cdninstagram.com/gone.jpg"
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("aborts once the byte cap is exceeded", async () => {
    const dns = new FakeDns({ "x.cdninstagram.com": ["157.240.2.35"] });
    const inner = new FakeDownloader({
      "https://x.cdninstagram.com/big.jpg": {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        bodyChunks: [new Uint8Array(600), new Uint8Array(600)],
      },
    });
    const result = await guardedDownload(
      { dns, inner, hostAllowlist: allowlist, maxBytes: 1000 },
      "https://x.cdninstagram.com/big.jpg"
    );
    await expect(
      (async () => {
        for await (const _ of result.body) {
          /* drain */
        }
      })()
    ).rejects.toThrow(/size|limit|exceeded/i);
  });
});
