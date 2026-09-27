import type { DnsResolver } from "../../ports/dns-resolver.js";
import type { HttpDownloader, DownloadResult } from "../../ports/http-downloader.js";
import { isPrivateIp, hostAllowed } from "../../domain/ssrf.js";

export interface GuardedDownloadDeps {
  dns: DnsResolver;
  inner: HttpDownloader;
  hostAllowlist: string[];
  maxBytes: number;
}

export interface GuardedDownloadResult {
  status: number;
  contentType: string | null;
  body: AsyncIterable<Uint8Array>;
}

const MAX_REDIRECTS = 3;

export class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Validates a single URL against the SSRF rules (spec §13.2): HTTPS only,
 * host on the allowlist, every resolved IP public. Throws before any
 * network call is made if any check fails.
 */
async function assertSafeToFetch(deps: GuardedDownloadDeps, url: string): Promise<void> {
  const parsed = new URL(url);

  if (parsed.protocol !== "https:") {
    throw new Error(`SSRF guard: only https URLs are allowed, got ${parsed.protocol}`);
  }

  if (!hostAllowed(parsed.hostname, deps.hostAllowlist)) {
    throw new Error(`SSRF guard: host ${parsed.hostname} is not on the allowlist`);
  }

  const ips = await deps.dns.resolve(parsed.hostname);
  if (ips.length === 0) {
    throw new Error(`SSRF guard: host ${parsed.hostname} did not resolve to any address`);
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(
        `SSRF guard: host ${parsed.hostname} resolved to a private/disallowed address`
      );
    }
  }
}

/**
 * Downloads a URL with SSRF protections: HTTPS only, host must match the
 * allowlist, every resolved IP must be public (checked before any network
 * call), redirects are followed by hand with each hop re-validated against
 * the same rules (so a redirect to a private address is caught even when
 * the original host was allowed), and the streamed body aborts once it
 * exceeds maxBytes. A non-2xx, non-redirect status throws HttpStatusError,
 * which the download service maps to an asset status (spec §6.4).
 */
export async function guardedDownload(
  deps: GuardedDownloadDeps,
  url: string,
  redirectsLeft: number = MAX_REDIRECTS
): Promise<GuardedDownloadResult> {
  await assertSafeToFetch(deps, url);

  const result: DownloadResult = await deps.inner.get(url);

  if (result.status >= 300 && result.status < 400) {
    if (redirectsLeft <= 0) {
      throw new Error(`SSRF guard: too many redirects following ${url}`);
    }
    if (!result.location) {
      throw new Error(`SSRF guard: redirect status ${result.status} with no location`);
    }
    const nextUrl = new URL(result.location, url).toString();
    return guardedDownload(deps, nextUrl, redirectsLeft - 1);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new HttpStatusError(result.status);
  }

  return {
    status: result.status,
    contentType: result.contentType,
    body: capBytes(result.body, deps.maxBytes),
  };
}

async function* capBytes(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number
): AsyncIterable<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`SSRF guard: download exceeded the ${maxBytes}-byte size limit`);
    }
    yield chunk;
  }
}
