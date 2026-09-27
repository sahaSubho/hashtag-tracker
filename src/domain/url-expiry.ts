const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isPlausible(ms: number): boolean {
  if (!Number.isFinite(ms)) return false;
  const now = Date.now();
  return ms > now - ONE_YEAR_MS && ms < now + THIRTY_DAYS_MS;
}

/**
 * Parses the expiry embedded in a signed Meta CDN URL, if present.
 *
 * Meta's CDN URLs carry expiry in different forms depending on the edge:
 * `oe` is a hex-encoded epoch-seconds value; `_nc_exp`/`expires` are
 * decimal epoch seconds. This is an assumption flagged in spec §19 — if the
 * real format differs, this function simply returns null more often and the
 * asset falls back to being retried without an expiry-priority ordering.
 */
export function parseUrlExpiry(url: string): Date | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const oe = parsed.searchParams.get("oe");
  if (oe !== null) {
    const epochSeconds = parseInt(oe, 16);
    const ms = epochSeconds * 1000;
    if (isPlausible(ms)) return new Date(ms);
  }

  for (const param of ["_nc_exp", "expires"]) {
    const value = parsed.searchParams.get(param);
    if (value !== null) {
      const epochSeconds = parseInt(value, 10);
      const ms = epochSeconds * 1000;
      if (isPlausible(ms)) return new Date(ms);
    }
  }

  return null;
}
