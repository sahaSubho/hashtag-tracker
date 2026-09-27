import pino, { type Logger, type LoggerOptions } from "pino";

const SIGNATURE_PARAM_PATTERN = /sig|token|proof/i;
const KNOWN_SIGNATURE_PARAMS = new Set(["oh", "oe", "_nc_ht", "stp", "ccb"]);

/**
 * Strips access tokens, appsecret_proof, and CDN signature parameters from a
 * URL so it is safe to place in logs or error messages. Returns a fixed
 * placeholder if the input cannot be parsed as a URL at all.
 */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "[unparseable-url]";
  }

  const toDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (KNOWN_SIGNATURE_PARAMS.has(key) || SIGNATURE_PARAM_PATTERN.test(key)) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    parsed.searchParams.delete(key);
  }

  return parsed.toString();
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "*.access_token",
        "*.appsecret_proof",
        "*.apiKey",
        "*.api_key",
        "config.metaAccessToken",
        "config.metaAppSecret",
      ],
      censor: "[redacted]",
    },
    ...opts,
  });
}
